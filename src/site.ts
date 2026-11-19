export type LngLatPair = [longitude: number, latitude: number];

// WGS84 演示点在北海北站附近，坐标、朝向与高度都不是现场测量数据。
export const deviceLocation = {
  coordinate: [116.38087, 39.93181] as LngLatPair,
  bearing: 86,
  altitude: 3.14,
};

export const coverage = {
  west: 116.368, south: 39.924, east: 116.409, north: 39.944,
};

export const areaBounds: [LngLatPair, LngLatPair] = [[116.372, 39.927], [116.397, 39.942]];

export const mapLabels: { text: string; location: LngLatPair; kind: string; maxZoom: number }[] = [
  { text: '北海北', location: [116.3800445, 39.9317985], kind: 'station', maxZoom: 19.6 },
  { text: '地安门西大街', location: [116.38350, 39.93199], kind: 'street', maxZoom: 19.7 },
  { text: '北海公园', location: [116.38297, 39.93002], kind: 'park', maxZoom: 19.2 },
  { text: '前海', location: [116.38754, 39.93638], kind: 'water', maxZoom: 18.4 },
  { text: '后海', location: [116.37833, 39.93953], kind: 'water', maxZoom: 18.4 },
  { text: '景山公园', location: [116.39643, 39.92589], kind: 'park', maxZoom: 18.8 },
  { text: '恭王府', location: [116.38553, 39.9365], kind: 'park', maxZoom: 18.6 },
];
