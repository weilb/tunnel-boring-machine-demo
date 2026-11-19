import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Matrix4, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three';
import { advanceAngles, createMachine, pickPart } from '../src/model.ts';
import { makeRoute } from '../src/route.ts';
import { areaBounds, coverage, deviceLocation, mapLabels } from '../src/site.ts';
import { createPresentation, createReveal } from '../src/presentation.ts';
import { sampleSurfaceLight } from '../src/surface-light.ts';

test('西城演示设备在本地底图和周边视野内，靠近北海北站', () => {
  const data = JSON.parse(readFileSync(new URL('../src/data/beijing-xicheng.geojson', import.meta.url), 'utf8'));
  assert.deepEqual(data.bbox, [coverage.west, coverage.south, coverage.east, coverage.north]);
  const [longitude, latitude] = deviceLocation.coordinate;
  const [[west, south], [east, north]] = areaBounds;
  assert.ok(coverage.west <= west && west < longitude && longitude < east && east <= coverage.east);
  assert.ok(coverage.south <= south && south < latitude && latitude < north && north <= coverage.north);
  const station = mapLabels.find((label) => label.text === '北海北');
  assert.ok(station);
  assert.ok(Math.hypot(station.location[0] - longitude, station.location[1] - latitude) < .002);
  const themes = new Set(data.features.map((feature: { properties: { theme: string } }) => feature.properties.theme));
  assert.deepEqual(themes, new Set(['water', 'green', 'building', 'road']));
});

test('设备位置取自线路，方向取当前线段，跨段不补连线', () => {
  const route = makeRoute([[[4.8, 45.7], [4.81, 45.7]], [[4.82, 45.72], [4.82, 45.73]]]);
  const east = route.locate(.1);
  assert.equal(east.coordinate[1], 45.7);
  assert.equal(east.bearing, 90);
  const north = route.locate(.9);
  assert.equal(north.coordinate[0], 4.82);
  assert.equal(north.bearing, 0);
  assert.equal(north.traversed.length, 2);
  assert.equal(route.locate(-1).distance, 0);
  assert.deepEqual(route.locate(2).coordinate, [4.82, 45.73]);
  assert.throws(() => makeRoute([[[4.8, 45.7], [4.8, 45.7]]]));
});

test('两个转速独立，6 rpm 十秒一圈，零速不推进相位', () => {
  const start = { cutter: 0, auger: 0 };
  const quarter = advanceAngles(start, 2.5, 6, 12);
  assert.ok(Math.abs(quarter.cutter - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(quarter.auger - Math.PI) < 1e-12);
  const loop = advanceAngles(start, 10, 6, 6);
  assert.ok(loop.cutter < 1e-12 && loop.auger < 1e-12);
  assert.deepEqual(advanceAngles(quarter, .8, 0, 0), quarter);
});

test('螺旋轴原地转，剖面切换不移动筒体，拾取跳过被移除的盾壳', () => {
  const machine = createMachine();
  const { root, auger, cutter } = machine;
  const shaftPoint = new Vector3(4, 0, 0);
  const original = auger.localToWorld(shaftPoint.clone());
  machine.setAngles({ cutter: Math.PI / 5, auger: Math.PI / 2 });
  assert.ok(auger.localToWorld(shaftPoint.clone()).distanceTo(original) < 1e-9);
  const tilted = auger.localToWorld(new Vector3(10, 0, 0)).sub(auger.localToWorld(new Vector3())).normalize();
  assert.ok(Math.abs(Math.asin(tilted.y) * 180 / Math.PI - 28) < 1e-9);
  assert.equal(cutter.position.y, 0);
  const ray = new Raycaster(new Vector3(.4, -.28, 9), new Vector3(0, 0, -1));
  const frontRay = new Raycaster(new Vector3(-9, 0, 0), new Vector3(1, 0, 0));
  root.updateMatrixWorld(true);
  assert.equal(pickPart(ray, root), 'shield');
  assert.equal(pickPart(frontRay, root), 'cutterhead');
  machine.setHighlight('auger_screw', true);
  root.updateMatrixWorld(true);
  assert.equal(pickPart(ray, root), 'auger_screw');
  assert.ok(auger.localToWorld(shaftPoint.clone()).distanceTo(original) < 1e-9);
  machine.setHighlight(null, false);
  assert.equal(pickPart(ray, root), 'shield');
});

test('透视保留整机轮廓并露出可选的螺旋叶片，切回原版后恢复材质和剖面', () => {
  const machine = createMachine();
  const { full, section, casing, cutCasing } = machine.meshGroups;
  const blade = machine.auger.children.find((child) => child instanceof Mesh && child.material instanceof MeshStandardMaterial)! as Mesh;
  const original = blade.material;
  const presentation = createPresentation(machine);
  const ray = new Raycaster(new Vector3(.4, -.28, 9), new Vector3(0, 0, -1));
  machine.setAngles({ cutter: .42, auger: Math.PI / 2 });
  machine.root.updateMatrixWorld(true);
  assert.equal(pickPart(ray, machine.root), 'shield');

  presentation.apply('xray', 'auger_screw', 1);
  assert.ok(full.visible && casing.visible && !section.visible && !cutCasing.visible);
  assert.equal(pickPart(ray, machine.root, 'auger_screw'), 'auger_screw');
  assert.notEqual(blade.material, original);
  assert.equal((blade.material as MeshStandardMaterial).transparent, false);
  const angle = machine.auger.quaternion.clone();

  presentation.apply('cutaway', 'auger_screw', 0);
  assert.ok(!full.visible && !casing.visible && section.visible && cutCasing.visible);
  const warm = blade.material as MeshStandardMaterial;
  assert.notEqual(warm, original);
  assert.ok(warm.emissive.r > warm.emissive.b);
  assert.ok(machine.auger.quaternion.equals(angle));
  presentation.apply('xray', null, 0);
  assert.ok(full.visible && casing.visible && !section.visible);
  assert.equal(blade.material, original);
  assert.equal(pickPart(ray, machine.root), 'shield');
  presentation.dispose();
});

test('剖视高亮只替换选中部件的材质，切换部件和回到整机后可还原', () => {
  const machine = createMachine();
  const presentation = createPresentation(machine);
  const cutterSurface = machine.meshGroups.cutter.children.find((node) => node instanceof Mesh && node.material instanceof MeshStandardMaterial) as Mesh;
  const shieldSurface = machine.meshGroups.full.children.find((node) => node instanceof Mesh && node.material instanceof MeshStandardMaterial) as Mesh;
  const cutterMaterial = cutterSurface.material;
  const shieldMaterial = shieldSurface.material;

  presentation.apply('cutaway', 'cutterhead', 0);
  assert.notEqual(cutterSurface.material, cutterMaterial);
  assert.equal(shieldSurface.material, shieldMaterial);
  presentation.apply('cutaway', 'shield', 0);
  assert.equal(cutterSurface.material, cutterMaterial);
  assert.notEqual(shieldSurface.material, shieldMaterial);
  presentation.apply('cutaway', null, 0);
  assert.equal(shieldSurface.material, shieldMaterial);
  presentation.dispose();
  machine.dispose();
});

test('透视等待镜头起步，反向时不跳帧，并支持无动画的最终状态', () => {
  const reveal = createReveal();
  reveal.go(1, 100, 600, 100);
  assert.equal(reveal.value(199), 0);
  assert.equal(reveal.value(500), .5);
  assert.ok(reveal.active(799));
  reveal.go(0, 500, 400);
  assert.equal(reveal.value(500), .5);
  assert.equal(reveal.value(700), .25);
  assert.equal(reveal.value(900), 0);
  assert.equal(reveal.active(900), false);
  reveal.go(1, 950, 0, 140);
  assert.equal(reveal.value(950), 1);
  assert.equal(reveal.active(950), false);
});

test('光带沿部件推进，低频重扫；减少动态效果时只保留稳定发光', () => {
  const start = sampleSurfaceLight(0, false);
  const moving = sampleSurfaceLight(700, false);
  const later = sampleSurfaceLight(1130, false);
  assert.equal(start.sweep, 0);
  assert.ok(start.head < moving.head && moving.head < later.head);
  assert.equal(moving.sweep, 1);
  assert.equal(sampleSurfaceLight(2200, false).sweep, 0);
  assert.ok(sampleSurfaceLight(4300, false).sweep > 0);
  assert.deepEqual(sampleSurfaceLight(700, true), sampleSurfaceLight(4300, true));
  assert.equal(sampleSurfaceLight(700, true).sweep, 0);
});

test('盾壳表面灯效不新增实体圈，原版与透视只在需要时继续重绘', () => {
  const machine = createMachine();
  const { full } = machine.meshGroups;
  const meshCount = () => full.children.filter((child) => child instanceof Mesh).length;
  const before = meshCount();
  const presentation = createPresentation(machine);
  const inverse = new Matrix4();
  presentation.apply('xray', 'shield', 1);
  assert.equal(meshCount(), before);
  assert.equal(presentation.updateLight(800, false, inverse), true);
  assert.equal(presentation.updateLight(800, true, inverse), false);
  presentation.apply('xray', 'auger_screw', 1);
  assert.equal(presentation.updateLight(800, false, inverse), false);
  presentation.apply('cutaway', 'auger_screw', 0);
  assert.equal(presentation.updateLight(800, false, inverse), true);
  presentation.apply('cutaway', null, 0);
  assert.equal(presentation.updateLight(800, false, inverse), false);
  presentation.dispose();
  machine.dispose();
});
