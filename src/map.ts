import { Map as MapLibreMap, Marker, MercatorCoordinate, NavigationControl, ScaleControl, setWorkerUrl, type CustomLayerInterface, type PaddingOptions } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import * as THREE from 'three';
import { addMachineLights, advanceAngles, createMachine, parts, pickPart, type Angles, type PartId, type ViewMode } from './model.ts';
import { createPresentation, createReveal } from './presentation.ts';
import { areaBounds, coverage, deviceLocation, mapLabels } from './site.ts';
import { cityStyle, createDeviceMarker, createFlatMap, createGeoLabel } from './basemap.ts';

// 把工作线程作为显式的本地资源打包，避开 Vite 预构建后默认相对路径失效的问题。
setWorkerUrl(workerUrl);

const closeZoom = 17.8;
const compactLayout = matchMedia('(max-width: 650px)');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const reduceMotion = () => motionPreference.matches;
const focusTime = 985;
const revealTime = 890;

type MapViewer = {
  hasModel: boolean;
  ready: Promise<void>;
  setInspection(mode: ViewMode, part: PartId | null): void;
  setSpeeds(cutter: number, auger: number): void;
  locate(): void;
  overview(): void;
  fitOverlay(): void;
};

export function createMap(host: HTMLElement, annotation: HTMLElement, panel: HTMLElement, basemapUrl: string, onPart: (part: PartId) => void): MapViewer {
  let selected: PartId | null = null;
  let mode: ViewMode = 'xray';
  let cutterRpm = 0;
  let augerRpm = 0;
  const markerButton = createDeviceMarker();

  let map: MapLibreMap;
  try {
    map = new MapLibreMap({ container: host, style: cityStyle(basemapUrl), center: deviceLocation.coordinate, zoom: 19.7, minZoom: 14.6, maxZoom: 22, maxPitch: 72,
      maxBounds: [[coverage.west, coverage.south], [coverage.east, coverage.north]],
      attributionControl: false, renderWorldCopies: false, fadeDuration: 0, dragRotate: true,
      locale: { 'NavigationControl.ZoomIn': '放大地图', 'NavigationControl.ZoomOut': '缩小地图', 'NavigationControl.ResetBearing': '地图朝北' },
      canvasContextAttributes: { antialias: true, powerPreference: 'high-performance' },
    });
  } catch (error) {
    console.warn('未能启用 WebGL，使用二维西城底图。', error);
    host.replaceChildren();
    return { hasModel: false, ready: createFlatMap(host, basemapUrl, markerButton), setInspection() {}, setSpeeds() {}, locate() {}, overview() {}, fitOverlay() {} };
  }
  markerButton.addEventListener('click', (event) => { event.stopPropagation(); locate(); });
  markerButton.addEventListener('dblclick', (event) => event.stopPropagation());
  map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-left');
  map.addControl(new ScaleControl({ maxWidth: 85, unit: 'metric' }), 'bottom-left');
  new Marker({ element: markerButton, anchor: 'center', subpixelPositioning: true }).setLngLat(deviceLocation.coordinate).addTo(map);
  const labels = mapLabels.map(({ text, location, kind, maxZoom }) => {
    const node = createGeoLabel(text, kind);
    new Marker({ element: node }).setLngLat(location).addTo(map);
    return { node, maxZoom };
  });

  let projector: ReturnType<typeof createMachineLayer> | null = null;
  function syncZoom() {
    const zoom = map.getZoom();
    markerButton.hidden = zoom >= closeZoom;
    for (const { node, maxZoom } of labels) node.hidden = zoom > maxZoom || (compactLayout.matches && zoom < 16 && !node.classList.contains('station'));
  }
  map.on('zoom', syncZoom);
  map.on('click', ({ point }) => {
    const part = projector?.pick(point.x, point.y);
    if (part) onPart(part);
  });
  map.on('mousemove', ({ point }) => { map.getCanvas().style.cursor = projector?.pick(point.x, point.y) ? 'pointer' : ''; });
  map.on('mouseout', () => { map.getCanvas().style.cursor = ''; });
  const ready = new Promise<void>((resolve, reject) => {
    const failLoad = ({ error }: { error: unknown }) => reject(error);
    map.once('error', failLoad);
    map.once('load', () => {
      map.off('error', failLoad);
      try {
        projector = createMachineLayer(map, annotation, () => map.getZoom() >= closeZoom);
        map.addLayer(projector.layer);
        projector.setInspection(mode, selected);
        projector.setSpeeds(cutterRpm, augerRpm);
        host.classList.add('is-ready');
        resolve();
      } catch (error) { reject(error); }
    });
  });

  /** 为右侧悬浮面板留空间；窄屏面板贴底，底图仍铺满整个视口。 */
  function cameraPadding(near: boolean): Required<PaddingOptions> {
    const width = host.clientWidth;
    const height = host.clientHeight;
    const rect = panel.getBoundingClientRect();
    if (compactLayout.matches) {
      const bottom = Math.round(Math.min(height * .69, Math.max(0, height - rect.top) + 4));
      const top = near ? Math.round(Math.min(62, (height - bottom) * .18)) : 24;
      return { top, right: 12, bottom, left: 12 };
    }
    return { top: near ? Math.round(height * .20) : 30, right: Math.max(24, width - rect.left + 24), bottom: 28, left: 30 };
  }

  /** 根据可用画布取景，只缩放地图，不修改模型的地理坐标或米制尺寸。 */
  function moveToDevice(animate: boolean) {
    const profile = mode === 'xray' && selected ? xrayCameras[selected] : selected ? sectionCameras[selected] : assemblyCamera;
    const padding = cameraPadding(true);
    const width = host.clientWidth - padding.right - padding.left;
    const height = host.clientHeight - padding.top - padding.bottom;
    const fit = Math.max(.14, Math.min(1, width / 660, height / 465));
    const zoom = Math.max(closeZoom + .1, profile.zoom + Math.log2(fit));
    // 刀盘特写只下移画面构图，保持原缩放和地理锚点；窄屏按可用高度缩小偏移。
    if (selected === 'cutterhead') padding.top += Math.round(Math.min(294, height * .38));
    const camera = { center: cameraCenter(profile.offset), zoom, bearing: (deviceLocation.bearing + profile.angle) % 360, pitch: profile.pitch, padding };
    if (!animate || reduceMotion()) map.jumpTo(camera);
    else if (map.getZoom() < closeZoom) map.flyTo({ ...camera, duration: focusTime });
    else map.easeTo({ ...camera, duration: focusTime });
  }

  let framing: 'device' | 'area' | null = 'device';
  function moveToArea(animate: boolean) {
    map.fitBounds(areaBounds, { padding: cameraPadding(false), absolutePadding: true, maxZoom: 16.2,
      bearing: 0, pitch: 0, duration: animate && !reduceMotion() ? 650 : 0 });
  }
  function fitOverlay() {
    if (framing === 'device') moveToDevice(false);
    if (framing === 'area') moveToArea(false);
  }
  function locate() {
    framing = 'device';
    moveToDevice(true);
  }
  // 手动探索后不自动拉回；主动点击定位或周边视野时才恢复自动构图。
  map.on('movestart', (event) => { if (event.originalEvent) framing = null; });
  map.on('resize', () => { syncZoom(); fitOverlay(); });
  fitOverlay();
  syncZoom();
  return {
    hasModel: true, ready, locate, fitOverlay,
    setInspection(nextMode, part) { mode = nextMode; selected = part; projector?.setInspection(mode, selected); },
    setSpeeds(cutter, auger) { cutterRpm = cutter; augerRpm = auger; projector?.setSpeeds(cutter, auger); },
    overview() { framing = 'area'; moveToArea(true); },
  };
}

const assemblyCamera = { angle: 133, pitch: 54, zoom: 20.14, offset: 0 };
// 只拉近部件镜头，整体视角不变；窄屏仍按浮层之外的可用空间适配。
const sectionCameras: Record<PartId, typeof assemblyCamera> = {
  cutterhead: { angle: 149, pitch: 58, zoom: 21.15, offset: 2 },
  auger_screw: { angle: 112, pitch: 62, zoom: 21.15, offset: -2 },
  shield: { angle: 103, pitch: 54, zoom: 21.15, offset: 0 },
};
const xrayCameras: Record<PartId, typeof assemblyCamera> = {
  cutterhead: { angle: 155, pitch: 56, zoom: 21.45, offset: 3.8 },
  auger_screw: { angle: 103, pitch: 58, zoom: 21.3, offset: -2.7 },
  shield: { angle: 111, pitch: 55, zoom: 21.3, offset: -.25 },
};

/** 仅偏移相机目标，不移动、放大或重新创建地理锚定的盾构机。 */
function cameraCenter(distance: number) {
  if (!distance) return deviceLocation.coordinate;
  const target = MercatorCoordinate.fromLngLat(deviceLocation.coordinate);
  const offset = target.meterInMercatorCoordinateUnits() * distance;
  const heading = THREE.MathUtils.degToRad(deviceLocation.bearing);
  target.x += Math.sin(heading) * offset;
  target.y -= Math.cos(heading) * offset;
  return target.toLngLat();
}

/** 米制模型、拾取、剖视和动画共用地图画布与投影，不另建相机视图。 */
function createMachineLayer(map: MapLibreMap, overlay: HTMLElement, shouldDraw: () => boolean) {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const { coordinate, bearing, altitude } = deviceLocation;
  const origin = MercatorCoordinate.fromLngLat(coordinate, altitude);
  const meters = origin.meterInMercatorCoordinateUnits();
  // 固定点位的米制变换只计算一次；每帧仅更新地图投影和部件的旋转相位。
  const transform = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z)
    .scale(new THREE.Vector3(meters, -meters, meters)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const frustum = new THREE.Frustum();
  const position = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const bounds = new THREE.Sphere(new THREE.Vector3(), 10);
  const machine = createMachine();
  machine.root.rotation.y = -THREE.MathUtils.degToRad(bearing + 90);
  const presentation = createPresentation(machine);
  const reveal = createReveal();
  const label = createPartAnnotation(overlay);
  const canvas = map.getCanvas();
  scene.add(machine.root);
  addMachineLights(scene);
  let renderer: THREE.WebGLRenderer;
  let onScreen = false;
  let selected: PartId | null = null;
  let mode: ViewMode = 'xray';
  let emphasizedPart: PartId | null = null;
  let waitingForModel = false;
  let lightStartedAt: number | null = null;
  let angles: Angles = { cutter: 0, auger: 0 };
  let cutterRpm = 0;
  let augerRpm = 0;
  let lastUpdate = performance.now();
  const refreshLight = () => map.triggerRepaint();

  /** 先按旧转速结算相位，再切换转速；镜头变化和暂停不会重置旋转角度。 */
  function advance(now: number) {
    if (cutterRpm || augerRpm) angles = advanceAngles(angles, (now - lastUpdate) / 1000, cutterRpm, augerRpm);
    lastUpdate = now;
  }

  const layer: CustomLayerInterface = {
    id: 'epb-machine', type: 'custom', renderingMode: '3d',
    onAdd(_map, gl) {
      renderer = new THREE.WebGLRenderer({ canvas, context: gl });
      renderer.autoClear = false;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      motionPreference.addEventListener('change', refreshLight);
    },
    render(_gl, input) {
      onScreen = false;
      if (!shouldDraw()) { label.hide(); return; }
      camera.projectionMatrix.fromArray(input.defaultProjectionData.mainMatrix).multiply(transform);
      if (!frustum.setFromProjectionMatrix(camera.projectionMatrix).intersectsSphere(bounds)) { label.hide(); return; }
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      const now = performance.now();
      if (waitingForModel) { reveal.go(1, now, revealTime, 60); waitingForModel = false; }
      const progress = reveal.value(now);
      presentation.apply(mode, mode === 'xray' ? emphasizedPart : selected, progress);
      // 灯效从模型可见的第一帧起计时，不受机械暂停或远景飞行耗时影响。
      const lighting = presentation.updateLight(now - (lightStartedAt ??= now), reduceMotion(), camera.projectionMatrixInverse);
      advance(now);
      machine.setAngles(angles);
      renderer.resetState();
      renderer.render(scene, camera);
      onScreen = true;
      if (selected) label.place(machine.labels[selected].getWorldPosition(position).applyMatrix4(camera.projectionMatrix), canvas.clientWidth, canvas.clientHeight);
      if (!document.hidden && (cutterRpm || augerRpm || reveal.active(now) || lighting)) map.triggerRepaint();
    },
    onRemove() {
      onScreen = false;
      label.hide();
      motionPreference.removeEventListener('change', refreshLight);
      presentation.dispose();
      machine.dispose();
      renderer?.dispose();
    },
  };
  function pick(x: number, y: number) {
    // 反投影到与最后一帧相同的模型坐标，只命中当前可见的网格。
    const { clientWidth, clientHeight } = canvas;
    if (!onScreen || !clientWidth || !clientHeight) return null;
    const clipX = 2 * x / clientWidth - 1;
    const clipY = 1 - 2 * y / clientHeight;
    position.set(clipX, clipY, -1).applyMatrix4(camera.projectionMatrixInverse);
    direction.set(clipX, clipY, 1).applyMatrix4(camera.projectionMatrixInverse).sub(position).normalize();
    raycaster.set(position, direction);
    return raycaster.ray.intersectsSphere(bounds) ? pickPart(raycaster, machine.root, mode === 'xray' ? emphasizedPart : null) : null;
  }
  return {
    layer, pick,
    setInspection(nextMode: ViewMode, part: PartId | null) {
      if (nextMode === mode && part === selected) return;
      const now = performance.now();
      mode = nextMode;
      selected = part;
      if (part) lightStartedAt = null;
      // 先让镜头起步，再沿机身淡出外壳。快速改选时沿用当前透明度，不闪回整机。
      if (mode === 'xray' && part) emphasizedPart = part;
      const xray = mode === 'xray' && Boolean(part);
      const duration = !reduceMotion() && mode === 'xray' ? (xray ? revealTime : 520) : 0;
      // 从远景飞来时等模型进入可见层级，避免相机到达前过渡已经结束。
      waitingForModel = xray && !onScreen && duration > 0 && reveal.value(now) < .03;
      if (waitingForModel) reveal.go(0, now, 0);
      else reveal.go(xray ? 1 : 0, now, duration, xray && reveal.value(now) < .03 ? 110 : 0);
      overlay.dataset.mode = mode;
      label.setPart(selected);
      map.triggerRepaint();
    },
    setSpeeds(cutter: number, auger: number) {
      advance(performance.now());
      cutterRpm = cutter;
      augerRpm = auger;
      if (onScreen) map.triggerRepaint();
    },
  };
}

/** 引线依附于部件投影点，拖动地图时跟随；视野外不显示，也不拦截点选。 */
function createPartAnnotation(overlay: HTMLElement) {
  const tag = overlay.querySelector<HTMLElement>('.part-tag')!;
  const path = overlay.querySelector('path')!;
  const dot = overlay.querySelector('circle')!;
  let tagWidth = 0;
  let lastLayout = '';
  return {
    hide() { overlay.hidden = true; },
    setPart(part: PartId | null) {
      overlay.hidden = true;
      if (!part) return;
      tag.querySelector('span')!.textContent = parts[part].number;
      tag.querySelector('strong')!.textContent = parts[part].name;
      tagWidth = 0;
      lastLayout = '';
    },
    place(point: THREE.Vector3, width: number, height: number) {
      if (Math.abs(point.x) >= 1 || Math.abs(point.y) >= 1 || Math.abs(point.z) > 1 || !width || !height) {
        overlay.hidden = true;
        return;
      }
      overlay.hidden = false;
      tagWidth ||= tag.offsetWidth;
      const x = Math.round((point.x + 1) * width / 2);
      const y = Math.round((1 - point.y) * height / 2);
      const leftSide = x + 45 + tagWidth > width - 15;
      const left = Math.round(THREE.MathUtils.clamp(leftSide ? x - 45 - tagWidth : x + 45, 8, width - tagWidth - 8));
      const top = Math.round(THREE.MathUtils.clamp(y - 48, 12, height - 47));
      const layout = `${x},${y},${left},${top}`;
      if (layout === lastLayout) return;
      lastLayout = layout;
      const end = leftSide ? left + tagWidth : left;
      dot.setAttribute('cx', `${x}`);
      dot.setAttribute('cy', `${y}`);
      path.setAttribute('d', `M ${x} ${y} L ${end + (leftSide ? 12 : -12)} ${top + 15} H ${end}`);
      tag.style.transform = `translate(${left}px, ${top}px)`;
    },
  };
}
