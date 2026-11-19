import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const dimensions = Object.freeze({ cutterDiameter: 6.14, shieldLength: 8, augerLength: 12, augerDiameter: .9, pitch: .5, tilt: 28 });
export type PartId = 'cutterhead' | 'auger_screw' | 'shield';
export type ViewMode = 'xray' | 'cutaway';
export type Angles = { cutter: number; auger: number };
export const parts = {
  cutterhead: { number: '01', name: '刀盘' },
  auger_screw: { number: '02', name: '螺旋输送机' },
  shield: { number: '03', name: '盾壳' },
} as const;

const tau = Math.PI * 2;
const front = -4;
const rear = 4;
const radius = dimensions.cutterDiameter / 2;
const xAxis = new THREE.Vector3(1, 0, 0);

/** 从实耗时间累积相位；视角切换及调速时保留已转过的角度。 */
export function advanceAngles(angles: Angles, elapsed: number, cutterRpm: number, augerRpm: number): Angles {
  if (!Number.isFinite(elapsed) || elapsed <= 0 || (cutterRpm === 0 && augerRpm === 0)) return angles;
  return { cutter: (angles.cutter + (cutterRpm * elapsed / 60) * tau) % tau, auger: (angles.auger + (augerRpm * elapsed / 60) * tau) % tau };
}

function metal(color: number, metalness = .38, roughness = .45) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness, side: THREE.DoubleSide });
}

function cylinderX(radius1: number, radius2: number, length: number, segments = 48) {
  return new THREE.CylinderGeometry(radius1, radius2, length, segments).rotateZ(-Math.PI / 2);
}

function addMesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/** 生成有壁厚的弧形筒体与封边；剖视直接换几何，射线不会命中已移除的近侧。 */
function shellGeometry(length: number, outer: number, inner: number, start = 0, span = tau, segments = 80) {
  const coords: number[] = [];
  const point = (axial: number, radial: number, angle: number) => [axial, Math.cos(angle) * radial, Math.sin(angle) * radial];
  function quad(first: number[], second: number[], third: number[], fourth: number[]) {
    coords.push(...first, ...second, ...third, ...first, ...third, ...fourth);
  }
  const low = -length / 2;
  const high = length / 2;
  for (let index = 0; index < segments; index++) {
    const angle = start + span * index / segments;
    const next = start + span * (index + 1) / segments;
    quad(point(low, outer, angle), point(low, outer, next), point(high, outer, next), point(high, outer, angle));
    quad(point(low, inner, next), point(low, inner, angle), point(high, inner, angle), point(high, inner, next));
    quad(point(low, inner, angle), point(low, inner, next), point(low, outer, next), point(low, outer, angle));
    quad(point(high, outer, angle), point(high, outer, next), point(high, inner, next), point(high, inner, angle));
  }
  if (span < tau - .00001) {
    for (const angle of [start, start + span]) quad(point(low, outer, angle), point(high, outer, angle), point(high, inner, angle), point(low, inner, angle));
  }
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** 一张连续的螺旋叶片。沿 X 前进一圈恰好一个螺距，外缘半径不被球形刀盘坐标混用。 */
function bladeGeometry() {
  const length = dimensions.augerLength - .24;
  const outer = dimensions.augerDiameter / 2;
  const inner = .158;
  const count = Math.ceil(length / dimensions.pitch * 30);
  const buffer: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index <= count; index++) {
    const travel = length * index / count;
    const angle = tau * travel / dimensions.pitch;
    for (const offset of [-.022, .022]) {
      for (const distance of [inner, outer]) {
        buffer.push(.12 + travel + offset, Math.cos(angle) * distance, Math.sin(angle) * distance);
      }
    }
    if (index === count) continue;
    const base = index * 4;
    for (const [first, second] of [[0, 1], [1, 3], [3, 2], [2, 0]]) {
      indices.push(base + first, base + second, base + second + 4, base + first, base + second + 4, base + first + 4);
    }
  }
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(buffer, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function spokeGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-.37, .57);
  shape.lineTo(-.42, 1.75);
  shape.lineTo(-.29, 2.95);
  shape.lineTo(.36, 2.95);
  shape.lineTo(.4, 2.1);
  shape.lineTo(.3, 1.24);
  shape.lineTo(.36, .57);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: .29, bevelEnabled: true, bevelSegments: 1, bevelSize: .05, bevelThickness: .06 })
    .rotateY(Math.PI / 2).translate(-.22, 0, 0);
}

/** 将静态材质相同的小件合批，保留独立转轴和所有可切换部件的节点边界。 */
function batch(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  const batches = new Map<THREE.Material, { meshes: THREE.Mesh[]; geometries: THREE.BufferGeometry[] }>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    geometry.deleteAttribute('uv');
    geometry.applyMatrix4(inverse.clone().multiply(object.matrixWorld));
    const entry = batches.get(object.material) ?? { meshes: [], geometries: [] };
    entry.meshes.push(object);
    entry.geometries.push(geometry);
    batches.set(object.material, entry);
  });
  for (const [material, entry] of batches) {
    if (entry.meshes.length > 1) {
      const geometry = mergeGeometries(entry.geometries);
      if (geometry) {
        const originals = new Set(entry.meshes.map((mesh) => mesh.geometry as THREE.BufferGeometry));
        entry.meshes.forEach((mesh) => mesh.removeFromParent());
        originals.forEach((geometry) => geometry.dispose());
        addMesh(group, geometry, material);
      }
    }
    entry.geometries.forEach((geometry) => geometry.dispose());
  }
}

export function createMachine() {
  const root = new THREE.Group();
  root.name = 'EPB-01';
  const orange = metal(0xde5528, .32, .39);
  const burnt = metal(0x99402a, .32, .5);
  const steel = metal(0x879c9e, .57, .4);
  const alloy = metal(0xbfc8b8, .47, .36);
  const graphite = metal(0x3c4748, .22, .62);
  const dark = metal(0x253137, .36, .56);
  const white = metal(0xffe6b2, .12, .42);
  const bronze = metal(0xb98e53, .52, .42);
  const inner = metal(0x576971, .36, .62);
  const rim = metal(0xc9ab7f, .45, .46);

  const full = new THREE.Group();
  const section = new THREE.Group();
  const frame = new THREE.Group();
  full.name = 'shield';
  section.name = 'shield_section';
  frame.name = 'shield_frame';
  root.add(full, section, frame);
  for (const skin of [full, section, frame]) skin.userData.partId = 'shield';

  const nearStart = Math.PI * .89;
  const shellArc = tau - nearStart - .16;
  function addSkin(group: THREE.Group, start: number, span: number) {
    addMesh(group, shellGeometry(dimensions.shieldLength, radius - .02, radius - .21, start, span), steel);
    for (const [at, width] of [[front + .25, .42], [-1.65, .13], [1.9, .13], [rear - .17, .36]]) {
      addMesh(group, shellGeometry(width, radius + .045, radius - .17, start, span), alloy, at);
    }
    for (let index = 0; index < 16; index++) {
      const angle = tau * (index + .32) / 16;
      if (angle < start || angle > start + span) continue;
      const mount = new THREE.Group();
      mount.rotation.x = angle;
      group.add(mount);
      for (const at of [-2.72, -.15, 2.75]) {
        addMesh(mount, new THREE.BoxGeometry(.37, .065, .31), graphite, at, radius - .012);
        addMesh(mount, new THREE.BoxGeometry(.25, .044, .14), alloy, at, radius + .033);
      }
    }
  }
  addSkin(full, 0, tau);
  addSkin(section, nearStart, shellArc);
  for (const edge of [nearStart, nearStart + shellArc]) {
    const bar = addMesh(section, new THREE.BoxGeometry(7.97, .17, .065), rim, 0, Math.cos(edge) * (radius - .11), Math.sin(edge) * (radius - .11));
    bar.rotation.x = edge;
  }

  addMesh(frame, shellGeometry(.46, radius - .215, 2.45), dark, front + .66);
  addMesh(frame, cylinderX(2.17, 2.17, .25), graphite, front + 1.73);
  addMesh(frame, cylinderX(1.35, 1.39, .34), steel, front + 1.95);
  addMesh(frame, shellGeometry(.08, 2.4, 1.88), alloy, front + 2.02);
  addMesh(frame, shellGeometry(.38, 2.9, 2.59, Math.PI * 1.01, Math.PI * .88), graphite, 2.9);
  for (const axial of [-.68, 2.2]) {
    addMesh(frame, new THREE.BoxGeometry(.21, .36, 3.5), graphite, axial, -2.13, -.13);
    for (const side of [-1, 1]) addMesh(frame, new THREE.BoxGeometry(2.8, .14, .37), steel, axial + .28, -2, side * 1.33);
  }

  const cutter = new THREE.Group();
  cutter.position.x = front - .19;
  cutter.name = 'cutterhead';
  cutter.userData.partId = 'cutterhead';
  root.add(cutter);
  addMesh(cutter, cylinderX(.79, .84, .68), burnt, .04);
  addMesh(cutter, cylinderX(.59, .66, .17), steel, -.45);
  addMesh(cutter, cylinderX(.29, .34, .18, 12), dark, -.57);
  addMesh(cutter, shellGeometry(.3, radius, 2.8), burnt, -.075);
  addMesh(cutter, shellGeometry(.13, radius, 2.86), orange, -.28);
  addMesh(cutter, shellGeometry(.07, 2.83, 2.76), alloy, .075);
  for (let index = 0; index < 6; index++) {
    const spoke = new THREE.Group();
    spoke.rotation.x = index * tau / 6;
    cutter.add(spoke);
    addMesh(spoke, spokeGeometry(), orange);
    addMesh(spoke, new THREE.BoxGeometry(.175, .96, .21), burnt, -.21, 1.55, .11);
    addMesh(spoke, new THREE.BoxGeometry(.18, .67, .13), index === 0 ? white : alloy, -.23, 2.2, .19);
    for (const [slot, distance] of [1.02, 1.39, 1.79, 2.24, 2.66, 2.93].entries()) {
      const lateral = slot % 2 ? .16 : -.14;
      addMesh(spoke, new THREE.BoxGeometry(.2, .24, .29), graphite, -.29, distance, lateral);
      addMesh(spoke, cylinderX(.104, .109, .115, 12), alloy, -.409, distance, lateral);
      addMesh(spoke, cylinderX(.039, .049, .056, 10), dark, -.481, distance, lateral);
    }
    for (const fraction of [.19, .42, .72]) {
      const angle = fraction * tau / 6;
      const bit = addMesh(spoke, new THREE.BoxGeometry(.17, .206, .229), alloy, -.27, Math.cos(angle) * (radius - .07), Math.sin(angle) * (radius - .07));
      bit.rotation.x = angle;
    }
  }
  addMesh(cutter, shellGeometry(.145, radius + .006, 2.845, -.093, .124, 10), white, -.288);
  addMesh(cutter, shellGeometry(.145, radius + .006, 2.85, .068, .08, 8), white, -.288);

  const conveyor = new THREE.Group();
  conveyor.name = 'conveyor_axis';
  conveyor.position.set(front + .56, -2.27, .03);
  conveyor.rotation.z = THREE.MathUtils.degToRad(dimensions.tilt);
  root.add(conveyor);
  const casing = new THREE.Group();
  const cutCasing = new THREE.Group();
  const ends = new THREE.Group();
  const auger = new THREE.Group();
  casing.name = 'auger_casing';
  cutCasing.name = 'auger_casing_section';
  ends.name = 'auger_casing_ends';
  auger.name = 'auger_screw';
  conveyor.add(casing, cutCasing, ends, auger);
  for (const part of [casing, cutCasing, ends, auger]) part.userData.partId = 'auger_screw';
  function addCasing(group: THREE.Group, start: number, span: number) {
    addMesh(group, shellGeometry(11.85, .595, .495, start, span, 64), inner, 6);
    for (const axial of [1.75, 4.14, 6.52, 8.88, 11.43]) {
      addMesh(group, shellGeometry(.11, .67, .545, start, span, 56), steel, axial);
    }
    if (span < tau) {
      for (const edge of [start, start + span]) {
        const bar = addMesh(group, new THREE.BoxGeometry(11.84, .10, .047), rim, 6, Math.cos(edge) * .55, Math.sin(edge) * .55);
        bar.rotation.x = edge;
      }
    }
  }
  addCasing(casing, 0, tau);
  addCasing(cutCasing, Math.PI * .88, Math.PI * 1.07);
  for (const end of [.14, 11.78]) {
    addMesh(ends, shellGeometry(.19, .686, .464), graphite, end);
    addMesh(ends, shellGeometry(.074, .654, .493), alloy, end + .12);
  }
  addMesh(ends, cylinderX(.42, .47, .52), graphite, 12.04);
  addMesh(ends, cylinderX(.40, .42, .53), steel, 12.55);
  for (const axial of [12.35, 12.44, 12.53, 12.62, 12.71, 12.8]) addMesh(ends, shellGeometry(.028, .447, .382), dark, axial);
  addMesh(ends, new THREE.BoxGeometry(.38, .24, .31), dark, 12.63, .42, -.02);
  addMesh(auger, cylinderX(.166, .166, 11.91, 32), steel, 6);
  addMesh(auger, bladeGeometry(), bronze);
  for (const axial of [5, 8.5]) addMesh(auger, new THREE.BoxGeometry(.18, .113, .071), white, axial, .372, -.052);

  const meshGroups = { full, section, frame, cutter, casing, cutCasing, ends, auger };
  for (const group of Object.values(meshGroups)) batch(group);

  const labels = {
    cutterhead: new THREE.Object3D(), auger_screw: new THREE.Object3D(), shield: new THREE.Object3D(),
  };
  labels.cutterhead.position.set(front - .53, .91, .73);
  labels.shield.position.set(.4, 1.1, 2.87);
  labels.auger_screw.position.set(8.48, .2, .36);
  root.add(labels.cutterhead, labels.shield);
  conveyor.add(labels.auger_screw);

  // 剖视件常共享原材质，按选中部件缓存独立材质，避免给相邻结构一起染色。
  const highlightGroups = { cutterhead: [cutter], shield: [full, section], auger_screw: [auger] };
  const sectionTint = new THREE.Color(0xe5a057);
  function createSectionHighlights(part: PartId) {
    const surfaces: { mesh: THREE.Mesh; original: THREE.MeshStandardMaterial; highlight: THREE.MeshStandardMaterial }[] = [];
    const materials = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
    for (const group of highlightGroups[part]) group.traverse((mesh) => {
      if (!(mesh instanceof THREE.Mesh) || !(mesh.material instanceof THREE.MeshStandardMaterial)) return;
      const original = mesh.material;
      let highlight = materials.get(original);
      if (!highlight) {
        highlight = original.clone();
        highlight.color.lerp(sectionTint, .52);
        highlight.emissive.setHex(0xff6708);
        highlight.emissiveIntensity = .20;
        materials.set(original, highlight);
      }
      surfaces.push({ mesh, original, highlight });
    });
    return surfaces;
  }
  const highlights = {
    cutterhead: createSectionHighlights('cutterhead'), shield: createSectionHighlights('shield'), auger_screw: createSectionHighlights('auger_screw'),
  };
  const sectionMaterials = new Set(Object.values(highlights).flat().map(({ highlight }) => highlight));
  let highlighted: PartId | null = null;

  /** 切换近侧外壳与筒壁，不移动转轴；离开剖视选中态时恢复原材质。 */
  function setHighlight(part: PartId | null, cut: boolean) {
    section.visible = cut;
    cutCasing.visible = cut;
    full.visible = !cut;
    casing.visible = !cut;
    if (highlighted === part) return;
    if (highlighted) for (const { mesh, original } of highlights[highlighted]) mesh.material = original;
    if (part) for (const { mesh, highlight } of highlights[part]) mesh.material = highlight;
    highlighted = part;
  }
  function setAngles(angles: Angles) {
    cutter.setRotationFromAxisAngle(xAxis, angles.cutter);
    auger.setRotationFromAxisAngle(xAxis, angles.auger);
  }
  setHighlight(null, false);
  return {
    root, setAngles, setHighlight, labels, meshGroups, sectionMaterials, cutter, auger,
    dispose() {
      const resources = new Set<THREE.BufferGeometry | THREE.Material>(sectionMaterials);
      setHighlight(null, false);
      root.traverse((mesh) => {
        if (!(mesh instanceof THREE.Mesh)) return;
        resources.add(mesh.geometry);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) resources.add(material);
      });
      for (const resource of resources) resource.dispose();
    },
  };
}

export function addMachineLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xf2efe4, 0x485158, 2.15));
  for (const [color, intensity, position] of [
    [0xffefd7, 3.35, [-7, 12, 7]], [0xbccff4, 1.7, [4, 5, -11]], [0xb6d4e4, 1.05, [3, 2, 11]],
  ] as const) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(position[0], position[1], position[2]);
    scene.add(light);
  }
}

/** 隐藏的网格不能拾取；透视模式可优先选中透明外壳后面的部件。 */
export function pickPart(ray: THREE.Raycaster, root: THREE.Group, preferred?: PartId | null): PartId | null {
  let nearest: PartId | null = null;
  let opaque: PartId | null = null;
  for (const hit of ray.intersectObject(root, true)) {
    let part: PartId | null = null;
    let visible = true;
    for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) {
      if (!object.visible) { visible = false; break; }
      part ??= object.userData.partId as PartId | undefined ?? null;
    }
    if (!visible || !part) continue;
    nearest ??= part;
    if (!hit.object.userData.transparentToPick) {
      if (!preferred || part === preferred) return part;
      opaque ??= part;
    }
  }
  return opaque ?? nearest;
}
