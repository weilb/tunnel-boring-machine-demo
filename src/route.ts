export type LngLat = [lng: number, lat: number];
const toRadians = Math.PI / 180;
const earthRadius = 6_371_008.8;

export interface RouteLocation {
  coordinate: LngLat;
  bearing: number;
  distance: number;
  traversed: LngLat[][];
}

function segmentLength(start: LngLat, end: LngLat) {
  const latitude = Math.sin((end[1] - start[1]) * toRadians / 2);
  const longitude = Math.sin((end[0] - start[0]) * toRadians / 2);
  const square = latitude ** 2 + Math.cos(start[1] * toRadians) * Math.cos(end[1] * toRadians) * longitude ** 2;
  return earthRadius * 2 * Math.asin(Math.min(1, Math.sqrt(square)));
}

/** 以线路平面距离推算演示位置；不会跨 MultiLineString 的断点补出假轨迹。 */
export function makeRoute(lines: LngLat[][]) {
  let total = 0;
  const segments = lines.flatMap((line, lineIndex) => line.slice(1).flatMap((end, segmentIndex) => {
    const start = line[segmentIndex];
    const length = segmentLength(start, end);
    if (length < 0.01) return [];
    const segment = { start, end, length, from: total, lineIndex, segmentIndex };
    total += length;
    return [segment];
  }));
  if (!segments.length) throw new Error('线路没有可用的线段');

  function locate(fraction: number): RouteLocation {
    const distance = Math.min(Math.max(0, Number.isFinite(fraction) ? fraction : 0), 1) * total;
    const segment = segments.find(({ from, length }) => distance <= from + length) ?? segments.at(-1)!;
    const offset = (distance - segment.from) / segment.length;
    const coordinate: LngLat = [
      segment.start[0] + (segment.end[0] - segment.start[0]) * offset,
      segment.start[1] + (segment.end[1] - segment.start[1]) * offset,
    ];
    const east = (segment.end[0] - segment.start[0]) * Math.cos(coordinate[1] * toRadians);
    const north = segment.end[1] - segment.start[1];
    const bearing = (Math.atan2(east, north) / toRadians + 360) % 360;
    const visited = [...lines.slice(0, segment.lineIndex), [...lines[segment.lineIndex].slice(0, segment.segmentIndex + 1), coordinate]];
    return { coordinate, bearing, distance, traversed: distance > 0 ? visited.filter((line) => line.length > 1) : [] };
  }

  return { locate, total };
}
