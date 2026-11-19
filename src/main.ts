import './styles.css';
import basemapUrl from './data/beijing-xicheng.geojson?url';
import { parts, type PartId, type ViewMode } from './model.ts';
import type { createMap } from './map.ts';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const mapHost = element('map-canvas');
const mapStatus = element('map-status');
const locator = element('locator');
const locatorBody = element('locator-body');
const locatorToggle = element<HTMLButtonElement>('locator-toggle');
const locateButton = element<HTMLButtonElement>('locate-device');
const areaButton = element<HTMLButtonElement>('area-button');
const motionSettings = element<HTMLDetailsElement>('motion-settings');
const cutterRpm = element<HTMLInputElement>('cutter-rpm');
const augerRpm = element<HTMLInputElement>('auger-rpm');
const playback = element<HTMLButtonElement>('playback');
const partList = element('part-list');
const viewMode = element('view-mode');
let map: ReturnType<typeof createMap> | null = null;
let selected: PartId | null = null;
let mode: ViewMode = 'xray';
let playing = true;

const ids = Object.keys(parts) as PartId[];
partList.innerHTML = ids.map((id) => {
  const part = parts[id];
  return `<button type="button" class="part-button" data-action="part" data-part="${id}" aria-pressed="false"><span class="part-no" aria-hidden="true">${part.number}</span><strong>${part.name}定位</strong><svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg></button>`;
}).join('');

function updateMotion() {
  // 设置面板的开合不参与播放状态；隐藏浏览器标签页时才暂时停止推进相位。
  const running = playing && !document.hidden;
  map?.setSpeeds(running ? cutterRpm.valueAsNumber : 0, running ? augerRpm.valueAsNumber : 0);
}

function updatePlayback() {
  element('play-text').textContent = playing ? '暂停' : '播放';
  playback.setAttribute('aria-label', playing ? '暂停动画' : '播放动画');
  document.getElementById('play-icon')!.setAttribute('href', playing ? '#i-pause' : '#i-play');
  updateMotion();
}

function updateRpm() {
  for (const [slider, outputId] of [[cutterRpm, 'cutter-value'], [augerRpm, 'auger-value']] as const) {
    const rpm = `${slider.value} rpm`;
    element(outputId).textContent = rpm;
    slider.setAttribute('aria-valuetext', rpm);
    slider.style.setProperty('--fill', `${100 * slider.valueAsNumber / Number(slider.max)}%`);
  }
  updateMotion();
}

function updatePart(partId: PartId | null) {
  selected = partId;
  map?.setInspection(mode, partId);
  for (const button of partList.querySelectorAll<HTMLButtonElement>('.part-button')) {
    button.setAttribute('aria-pressed', `${button.dataset.part === partId}`);
  }
}

/** 地图上点选和右侧列表使用同一个检查状态，始终保留同一张地图。 */
function focusPart(partId: PartId, toggle = false) {
  updatePart(toggle && partId === selected ? null : partId);
  map?.locate();
}

/** 切换展示方式时保留当前部件；未选择时定位刀盘，首次打开仍是整机。 */
function switchMode(next: ViewMode) {
  if (mode === next) return;
  mode = next;
  locator.dataset.mode = mode;
  for (const button of viewMode.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    button.setAttribute('aria-pressed', `${button.dataset.mode === mode}`);
  }
  focusPart(selected ?? 'cutterhead');
}

async function loadMap() {
  try {
    const { createMap } = await import('./map.ts');
    const viewer = createMap(mapHost, element('map-annotation'), locator, basemapUrl, focusPart);
    map = viewer;
    await viewer.ready;
    locateButton.disabled = areaButton.disabled = !viewer.hasModel;
    motionSettings.hidden = !viewer.hasModel;
    viewMode.hidden = !viewer.hasModel;
    if (!viewer.hasModel) {
      element('part-help').textContent = '当前浏览器未启用 WebGL，仅显示底图和设备位置。';
      for (const button of partList.querySelectorAll('button')) button.disabled = true;
      selected = null;
    }
    mapStatus.hidden = true;
    updatePart(selected);
    updateMotion();
    if (selected) viewer.locate();
    else viewer.fitOverlay();
  } catch (error) {
    console.error(error);
    mapStatus.textContent = '地图暂未加载，请刷新页面重试。';
  }
}

locatorToggle.addEventListener('click', () => {
  locatorBody.hidden = !locatorBody.hidden;
  locatorToggle.setAttribute('aria-expanded', `${!locatorBody.hidden}`);
  locatorToggle.title = locatorBody.hidden ? '展开设备定位' : '收起设备定位';
  locatorToggle.setAttribute('aria-label', locatorToggle.title);
  map?.fitOverlay();
});
locator.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  switch (button.dataset.action) {
    case 'locate': updatePart(null); map?.locate(); break;
    case 'overview': updatePart(null); map?.overview(); break;
    case 'mode': if (button.dataset.mode === 'xray' || button.dataset.mode === 'cutaway') switchMode(button.dataset.mode); break;
    case 'part': {
      const partId = button.dataset.part as PartId;
      if (ids.includes(partId)) focusPart(partId, true);
      break;
    }
    case 'play': playing = !playing; updatePlayback(); break;
  }
});
cutterRpm.addEventListener('input', updateRpm);
augerRpm.addEventListener('input', updateRpm);
motionSettings.addEventListener('toggle', () => map?.fitOverlay());
document.addEventListener('visibilitychange', updateMotion);
updateRpm();
loadMap();
