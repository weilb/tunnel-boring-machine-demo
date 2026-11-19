import type { FeatureCollection, LineString, Polygon } from 'geojson';
import type { StyleSpecification } from 'maplibre-gl';
import { coverage, deviceLocation, mapLabels } from './site.ts';

export function cityStyle(basemapUrl: string): StyleSpecification {
  return {
    version: 8,
    sources: { city: { type: 'geojson', data: basemapUrl, maxzoom: 17 } },
    layers: [
      { id: 'paper', type: 'background', paint: { 'background-color': '#eeeee7' } },
      { id: 'landscape', type: 'fill', source: 'city', filter: ['==', ['get', 'theme'], 'green'], paint: { 'fill-color': '#dbe6d5' } },
      { id: 'water', type: 'fill', source: 'city', filter: ['==', ['get', 'theme'], 'water'], paint: { 'fill-color': '#aacdd0', 'fill-outline-color': '#9abec3' } },
      { id: 'buildings', type: 'fill', source: 'city', minzoom: 15, filter: ['==', ['get', 'theme'], 'building'], paint: {
        'fill-color': '#dcdad1', 'fill-outline-color': '#d2d0c6', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 15, .25, 16.4, .8, 18, 1],
      } },
      { id: 'minor-roads', type: 'line', source: 'city', minzoom: 15, filter: ['all', ['==', ['get', 'theme'], 'road'], ['>=', ['get', 'rank'], 3]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: {
        'line-color': ['case', ['==', ['get', 'rank'], 3], '#fffefa', '#f9f9f1'],
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 15, 1, 17, ['match', ['get', 'rank'], 3, 4.4, 4, 2.6, 1.4], 21, ['match', ['get', 'rank'], 3, 39, 4, 19, 9]],
      } },
      { id: 'major-road-edge', type: 'line', source: 'city', filter: ['all', ['==', ['get', 'theme'], 'road'], ['<=', ['get', 'rank'], 2]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: {
        'line-color': '#d9d1bd',
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 2.8, 16, ['case', ['==', ['get', 'rank'], 1], 7.5, 5.1], 21, ['case', ['==', ['get', 'rank'], 1], 147, 77]],
      } },
      { id: 'major-roads', type: 'line', source: 'city', filter: ['all', ['==', ['get', 'theme'], 'road'], ['<=', ['get', 'rank'], 2]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: {
        'line-color': ['case', ['==', ['get', 'rank'], 1], '#faf4dc', '#fbf9ed'],
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 1.8, 16, ['case', ['==', ['get', 'rank'], 1], 6, 4], 21, ['case', ['==', ['get', 'rank'], 1], 143, 74]],
      } },
    ],
  };
}

export function createDeviceMarker() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'device-marker';
  button.setAttribute('aria-label', '定位地图上的 EPB-01');
  button.innerHTML = '<span class="direction-pin"><svg class="icon" aria-hidden="true"><use href="#i-pin"/></svg></span><span class="marker-callout">EPB-01</span>';
  return button;
}

export function createGeoLabel(text: string, kind: string) {
  const label = document.createElement('span');
  label.className = `geo-label ${kind}`;
  label.textContent = text;
  return label;
}

/** 不支持 WebGL 时，用同一份本地数据绘制二维底图和设备点位。 */
export async function createFlatMap(host: HTMLElement, basemapUrl: string, button: HTMLButtonElement) {
  const response = await fetch(basemapUrl);
  if (!response.ok) throw new Error(`底图加载失败：${response.status}`);
  const data: FeatureCollection<Polygon | LineString, { theme: string; rank?: number }> = await response.json();
  const project = ([longitude, latitude]: number[]) => [
    (longitude - coverage.west) / (coverage.east - coverage.west) * 1000,
    (coverage.north - latitude) / (coverage.north - coverage.south) * 630,
  ];
  const pathFor = (line: number[][]) => line.map((point, index) => `${index ? 'L' : 'M'}${project(point).map((value) => value.toFixed(1)).join(' ')}`).join('');
  const paths: Record<string, string[]> = { green: [], water: [], building: [], road: [], major: [] };
  for (const { properties, geometry } of data.features) {
    const { theme, rank } = properties;
    if (geometry.type === 'Polygon') paths[theme]?.push(geometry.coordinates.map((ring) => `${pathFor(ring)}Z`).join(''));
    else paths[(rank ?? 5) <= 2 ? 'major' : 'road'].push(pathFor(geometry.coordinates));
  }
  host.innerHTML = `<svg class="flat-basemap" preserveAspectRatio="none" viewBox="0 0 1000 630" aria-hidden="true">${Object.entries(paths).map(([theme, geometry]) => `<path class="${theme}" d="${geometry.join(' ')}"/>`).join('')}</svg>`;
  function place(node: HTMLElement, coords: number[]) {
    const [left, top] = project(coords);
    node.style.left = `${left / 10}%`;
    node.style.top = `${top / 6.3}%`;
    host.append(node);
  }
  for (const { text, location, kind } of mapLabels) place(createGeoLabel(text, kind), location);
  button.setAttribute('aria-label', '模拟设备位置 EPB-01');
  button.disabled = true;
  place(button, deviceLocation.coordinate);
  host.classList.add('flat-map', 'is-ready');
}
