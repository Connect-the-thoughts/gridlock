// Two-route toy: zone A at node 0, zone B at node 3.
// Route 1: 0→1→3 (fast, low cap). Route 2: 0→2→3 (slow, high cap).
export function toyCity() {
  const link = (id, from, to, kmh, lengthM, cap) =>
    ({ id, from, to, name: 'L' + id, cls: 'primary', lanes: 1, oneway: true, kmh, lengthM, capacityVph: cap, builtUp: false, xy: [[0,0],[1,1]] });
  return {
    meta: { id: 'toy', name: 'Toy', population: 1000, budget: 5e6, baselineDelayVehH: 0 },
    nodes: [0,1,2,3].map(i => ({ id: i, x: i, y: 0, lat: 0, lon: 0, legs: 2, control: 'none' })),
    links: [ link(0,0,1,60,1000,500), link(1,1,3,60,1000,500), link(2,0,2,40,1000,2000), link(3,2,3,40,1000,2000) ],
    zones: [ { id: 0, node: 0, name: 'A', productions: 1500, attractions: 0 }, { id: 1, node: 3, name: 'B', productions: 0, attractions: 1500 } ],
    od: [[0, 1500],[0, 0]],
    sites: { widenable: [], turnLane: [], roundabout: [], corridors: [], parkAndRide: [] },
    transit: { baseHeadwayMin: 30, baseFare: 2.5, corridorNodeIds: [] },
    proposals: []
  };
}
