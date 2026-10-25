/* TransitCorridor. Static client only; provider URLs live here for easy replacement. */
(() => {
  'use strict';
  const SERVICES = Object.freeze({
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    search: 'https://photon.komoot.io/api/',
    route: 'https://router.project-osrm.org/route/v1/driving/',
    overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
  });
  // A small, source-linked starter guide. It is matched to every route, never to endpoint names.
  // Coordinates were checked against OSM on 2026-10-25. Reports do not confirm today's bus schedule.
  const GUIDE_PLACES = [
    { id: 'way/294637577', name: 'Dada at Nene · Tiaong', coordinate: [121.3780326, 13.9403155], kind: 'rest', facilities: ['food', 'toilets'], facilityEvidence: { food: 'listed', toilets: 'reported' }, evidence: 'Traveler-reported bus stopover · Tiaong', busEvidence: 'reported', sources: [{ label: 'Place and traveler reports', url: 'https://pilipinas.worldorgs.com/Katalogo/tiaong/cafe/dada-nene-eatery-and-convenience-store' }, { label: 'OpenStreetMap location', url: 'https://www.openstreetmap.org/way/294637577' }] },
    { id: 'way/780424870', name: "McDonald's · Pagbilao", coordinate: [121.6535618, 13.9599336], kind: 'facility', facilities: ['food'], facilityEvidence: { food: 'mapped' }, evidence: 'Mapped food stop · bus stopovers reported by travelers', busEvidence: 'reported', sources: [{ label: 'OpenStreetMap place', url: 'https://www.openstreetmap.org/way/780424870' }, { label: 'Traveler stopover reports', url: 'https://www.reddit.com/r/Bicol/comments/1hrwvn1/' }] },
    { id: 'way/967501010', name: 'Rostan · Tagkawayan', coordinate: [122.5382551, 13.9701293], kind: 'rest', facilities: ['food', 'toilets'], facilityEvidence: { food: 'listed', toilets: 'reported' }, evidence: 'Traveler-reported bus and refueling stop · Andaya Highway', busEvidence: 'reported', sources: [{ label: 'Place and traveler reports', url: 'https://pilipinas.worldorgs.com/Katalogo/bayan-ng-tagkawayan/gas-station/rostan-gasoline-station' }, { label: 'OpenStreetMap location', url: 'https://www.openstreetmap.org/way/967501010' }] },
    { id: 'node/12101838090', name: "Bigg's · Pili", coordinate: [123.2652478, 13.570674], kind: 'facility', facilities: ['food'], facilityEvidence: { food: 'mapped' }, evidence: 'Highway restaurant · check coach access with your operator', busEvidence: 'unverified', sources: [{ label: 'Official branch listing', url: 'https://biggs.ph/biggs_website/branches' }, { label: 'OpenStreetMap place', url: 'https://www.openstreetmap.org/node/12101838090' }] }
  ].map(place => ({ ...place, source: 'guide', checked: '2026-10-25' }));
  const PROFILES = { provincial: 60, express: 48, ordinary: 30 };
  const CACHE_PREFIX = 'transitcorridor:v3:';
  const CACHE_TTL = 30 * 60 * 1000;
  const MAX_ROUTE_KM = 1800;
  const $ = id => document.getElementById(id);
  const state = {
    origin: null, destination: null, route: null, index: null, stops: [], selected: new Map(), manual: [],
    generation: 0, controller: null, stopController: null, stopGeneration: 0,
    filter: 'all', visible: 24, picking: null, speed: 60, sheet: 'half',
    searchControllers: {}, searchVersions: { origin: 0, destination: 0 }, locationVersion: 0,
    stopPhase: 'idle', routeCacheKey: '', fetching: false, stopRetryAt: 0
  };
  const memoryCache = new Map();
  let map, tileLayer, routeLayer, endpointLayer, stopLayer, toastTimer, searchNextAt = 0;
  let searchQueue = Promise.resolve();
  const stopMarkers = new Map();
  const abortError = () => new DOMException('Request cancelled', 'AbortError');
  const isAbort = error => error?.name === 'AbortError';
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
  }
  function status(message = '', error = false) {
    $('status').textContent = message;
    $('status').hidden = !message;
    $('status').classList.toggle('error', error);
  }
  function setBusy(busy) {
    state.fetching = busy;
    // Keep cancellation possible through endpoint edits; never queue duplicate planning requests.
    $('plan-button').disabled = busy;
    $('plan-button').classList.toggle('busy', busy);
    $('plan-label').textContent = busy ? 'Finding the road…' : state.route ? 'Update route' : 'Find my route';
  }
  function readCache(key) {
    const now = Date.now();
    let record = memoryCache.get(key);
    if (!record) {
      try { record = JSON.parse(sessionStorage.getItem(CACHE_PREFIX + key)); } catch { /* Storage is optional. */ }
    }
    if (!record || now - record.time > CACHE_TTL) return null;
    memoryCache.set(key, record);
    return record.data;
  }
  function writeCache(key, data) {
    const record = { time: Date.now(), data };
    memoryCache.set(key, record);
    if (memoryCache.size > 16) memoryCache.delete(memoryCache.keys().next().value);
    try {
      const keys = Object.keys(sessionStorage).filter(k => k.startsWith(CACHE_PREFIX));
      const ordered = keys.map(k => {
        try { return [k, JSON.parse(sessionStorage.getItem(k)).time || 0]; } catch { return [k, 0]; }
      }).sort((a, b) => a[1] - b[1]);
      while (ordered.length >= 12) sessionStorage.removeItem(ordered.shift()[0]);
      sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(record));
    } catch { /* Private browsing and full storage must not block planning. */ }
  }
  async function fetchJSON(url, options = {}, parentSignal, timeout = 18000) {
    if (parentSignal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' });
      if (!response.ok) {
        const error = new Error(response.status === 429 ? 'This service is busy. Wait a little, then try again.' : `The service returned HTTP ${response.status}. Please try again.`);
        error.httpStatus = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (parentSignal?.aborted) throw abortError();
      if (timedOut) throw new Error('The service took too long to respond. Please try again.');
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    }
  }
  const inPhilippines = (lon, lat) => Number.isFinite(lon) && Number.isFinite(lat) && lon >= 116 && lon <= 127.5 && lat >= 4.2 && lat <= 21.5;
  function duration(minutes) {
    const n = Math.max(0, Math.ceil(minutes));
    return n >= 60 ? `${Math.floor(n / 60)} hr${Math.floor(n / 60) === 1 ? '' : 's'}${n % 60 ? ` ${n % 60} min` : ''}` : `${n} min`;
  }
  const kmText = meters => `${(meters / 1000).toLocaleString('en-PH', { maximumFractionDigits: 1 })} km`;
  function distance(a, b) {
    const r = Math.PI / 180;
    const h = Math.sin((b[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin((b[0] - a[0]) * r / 2) ** 2;
    return 12742000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }
  function projection(coordinates) {
    const lat = coordinates[Math.floor(coordinates.length / 2)][1];
    const sx = 111320 * Math.cos(lat * Math.PI / 180), sy = 111320;
    return point => [point[0] * sx, point[1] * sy];
  }
  function segmentDistance(point, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const den = dx * dx + dy * dy;
    const t = den ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / den)) : 0;
    return { squared: (point[0] - a[0] - t * dx) ** 2 + (point[1] - a[1] - t * dy) ** 2, t };
  }
  function simplify(coordinates, tolerance = 60) {
    const project = projection(coordinates), points = coordinates.map(project);
    const keep = new Set([0, points.length - 1]);
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [start, end] = stack.pop();
      let best = tolerance * tolerance, index = -1;
      for (let i = start + 1; i < end; i++) {
        const d = segmentDistance(points[i], points[start], points[end]).squared;
        if (d > best) { best = d; index = i; }
      }
      if (index !== -1) { keep.add(index); stack.push([start, index], [index, end]); }
    }
    return [...keep].sort((a, b) => a - b).map(i => coordinates[i]);
  }
  function buildIndex(coordinates) {
    const project = projection(coordinates), points = coordinates.map(project), segments = [], grid = new Map();
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], length = distance(coordinates[i - 1], coordinates[i]);
      const id = segments.length;
      segments.push({ a, b, start: total, length });
      total += length;
      const minX = Math.floor(Math.min(a[0], b[0]) / 1000), maxX = Math.floor(Math.max(a[0], b[0]) / 1000);
      const minY = Math.floor(Math.min(a[1], b[1]) / 1000), maxY = Math.floor(Math.max(a[1], b[1]) / 1000);
      for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
        const key = `${x},${y}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(id);
      }
    }
    return { project, segments, grid, total };
  }
  function nearest(index, coordinate, radius = 1000) {
    const p = index.project(coordinate), ids = new Set();
    for (let x = Math.floor((p[0] - radius) / 1000); x <= Math.floor((p[0] + radius) / 1000); x++) {
      for (let y = Math.floor((p[1] - radius) / 1000); y <= Math.floor((p[1] + radius) / 1000); y++) {
        for (const id of index.grid.get(`${x},${y}`) || []) ids.add(id);
      }
    }
    let best = { offset: Infinity, along: 0 };
    for (const id of ids) {
      const seg = index.segments[id], result = segmentDistance(p, seg.a, seg.b);
      const offset = Math.sqrt(result.squared);
      if (offset < best.offset) best = { offset, along: seg.start + seg.length * result.t };
    }
    return best;
  }
  function pointInRing(point, ring) {
    if (ring.length < 4) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function centerOf(item) {
    const lon = item.lon ?? item.center?.lon, lat = item.lat ?? item.center?.lat;
    return inPhilippines(lon, lat) ? [lon, lat] : null;
  }
  function ringsOf(item) {
    if (item.type === 'way' && item.geometry?.length > 3) {
      const g = item.geometry;
      if (g[0].lon === g.at(-1).lon && g[0].lat === g.at(-1).lat) return [g.map(p => [p.lon, p.lat])];
    }
    // Only complete outer rings are used. Open relation fragments cannot establish containment.
    if (item.type === 'relation') return (item.members || []).filter(m => m.role === 'outer' && m.geometry?.length > 3).flatMap(m => ringsOf({ type: 'way', geometry: m.geometry }));
    return [];
  }
  function usable(tags) {
    if (!tags) return false;
    if (['no', 'private'].includes(tags.access) || tags.bus === 'no' || tags.tourist_bus === 'no') return false;
    if ((tags.motor_vehicle === 'no' || tags.vehicle === 'no') && !['yes', 'designated'].includes(tags.bus)) return false;
    return !['yes', 'true'].includes(tags.disused) && !['yes', 'true'].includes(tags.abandoned) && !tags['disused:amenity'] && !tags['disused:highway'] && !tags['abandoned:amenity'] && !tags['construction:amenity'] && tags.construction !== 'yes';
  }
  const named = tags => tags['name:en'] || tags.name || tags.brand || tags.operator || '';
  const siteKind = tags => ['services', 'rest_area'].includes(tags.highway) ? 'rest' : tags.amenity === 'bus_station' ? 'terminal' : null;
  const busAccess = tags => ['yes', 'designated'].includes(tags.bus) || ['yes', 'designated'].includes(tags.tourist_bus) || Number(tags['capacity:bus']) > 0;
  const stopoverName = tags => /\b(?:bus\s+stop(?:over)?|stop[\s-]?over|travel\s+plaza)\b/i.test(named(tags));
  const foodAmenity = tags => ['restaurant', 'fast_food', 'food_court'].includes(tags.amenity);
  function facilities(tags) {
    const result = [];
    if (foodAmenity(tags) || tags.restaurant === 'yes' || tags.food === 'yes') result.push('food');
    if ((tags.amenity === 'toilets' || tags.toilets === 'yes') && !['no', 'private'].includes(tags['toilets:access'])) result.push('toilets');
    return result;
  }
  async function classifyPlaces(elements, index, radius, signal) {
    const sites = [], standalone = [], seen = new Set();
    let processed = 0;
    for (const item of elements) {
      if (signal?.aborted) throw abortError();
      if (++processed % 100 === 0) await pause(0, signal);
      if (!usable(item.tags)) continue;
      const coordinate = centerOf(item);
      if (!coordinate) continue;
      const id = `${item.type}/${item.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const kind = siteKind(item.tags);
      if (!kind) continue;
      const snap = nearest(index, coordinate, radius + 250);
      if (snap.offset > radius) continue;
      sites.push({ id, coordinate, name: named(item.tags) || (kind === 'terminal' ? 'Mapped bus terminal' : 'Mapped rest area'), kind, facilities: facilities(item.tags), along: snap.along, offset: snap.offset, rings: ringsOf(item), evidence: kind === 'terminal' ? 'Mapped bus terminal' : item.tags.highway === 'services' ? 'Mapped highway service area' : 'Mapped highway rest area' });
    }
    let iteration = 0;
    for (const item of elements) {
      if (signal?.aborted) throw abortError();
      if (++iteration % 160 === 0) await pause(0, signal);
      if (!usable(item.tags) || siteKind(item.tags)) continue;
      const coordinate = centerOf(item);
      if (!coordinate || (!foodAmenity(item.tags) && item.tags.amenity !== 'toilets')) continue;
      const types = facilities(item.tags);
      if (!types.length) continue;
      const containing = sites.find(site => site.rings.some(ring => pointInRing(coordinate, ring)));
      if (containing) {
        containing.facilities = [...new Set([...containing.facilities, ...types])];
        continue;
      }
      // Proximity alone is not evidence that a restaurant or toilet can accommodate a bus.
      if (!busAccess(item.tags) && !stopoverName(item.tags)) continue;
      const snap = nearest(index, coordinate, radius + 250);
      if (snap.offset > radius) continue;
      const name = named(item.tags);
      if (!name && foodAmenity(item.tags)) continue;
      standalone.push({ id: `${item.type}/${item.id}`, coordinate, name: name || 'Bus-accessible toilets', kind: 'facility', facilities: types, along: snap.along, offset: snap.offset, evidence: busAccess(item.tags) ? 'Facility tagged for bus access' : 'Named stopover · coach access unverified', busEvidence: busAccess(item.tags) ? 'mapped' : 'unverified' });
    }
    const result = [], buckets = new Map();
    for (const place of [...sites, ...standalone].sort((a, b) => a.along - b.along)) {
      const bucketKey = `${place.kind}:${place.name.toLowerCase()}`;
      const bucket = buckets.get(bucketKey) || [];
      const duplicate = bucket.find(p => Math.abs(p.along - place.along) < 250 && distance(p.coordinate, place.coordinate) < 90);
      if (duplicate) duplicate.facilities = [...new Set([...duplicate.facilities, ...place.facilities])];
      else { delete place.rings; result.push(place); bucket.push(place); buckets.set(bucketKey, bucket); }
    }
    return result;
  }
  function overpassQuery(coordinates, radius) {
    // Short overlapping bounding boxes are faster for rare tags than a long around-polyline query.
    // Every returned place is still checked against the exact road geometry in a worker.
    const boxes = [];
    let chunk = [coordinates[0]], traveled = 0;
    const emit = points => {
      const lons = points.map(p => p[0]), lats = points.map(p => p[1]);
      const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
      const dy = (radius + 50) / 111320, dx = dy / Math.cos(lat * Math.PI / 180);
      boxes.push(`(${(Math.min(...lats) - dy).toFixed(5)},${(Math.min(...lons) - dx).toFixed(5)},${(Math.max(...lats) + dy).toFixed(5)},${(Math.max(...lons) + dx).toFixed(5)})`);
    };
    for (let i = 1; i < coordinates.length; i++) {
      traveled += distance(coordinates[i - 1], coordinates[i]); chunk.push(coordinates[i]);
      if (traveled >= 22000 || chunk.length >= 2500) { emit(chunk); chunk = [coordinates[i]]; traveled = 0; }
    }
    if (chunk.length > 1) emit(chunk);
    const arounds = [...new Set(boxes)];
    const amenity = '["amenity"~"^(restaurant|fast_food|food_court|toilets)$"]';
    return `[out:json][timeout:12][maxsize:134217728];\n(\n${arounds.map(a => `nwr["highway"="services"]${a};nwr["highway"="rest_area"]${a};nwr["amenity"="bus_station"]${a};`).join('\n')}\n)->.sites;\n( .sites; nwr(around.sites:180)${amenity};\n${arounds.map(a => `nwr["bus"="yes"]${amenity}${a};nwr["bus"="designated"]${amenity}${a};nwr["tourist_bus"="yes"]${amenity}${a};nwr${amenity}["capacity:bus"]${a};nwr${amenity}["name"~"stop.?over|bus stop|travel plaza",i]${a};`).join('\n')}\n);out body center geom qt;`;
  }
  function guidePlaces(coordinates, radius) {
    const index = buildIndex(coordinates);
    return GUIDE_PLACES.flatMap(place => {
      const snap = nearest(index, place.coordinate, radius + 100);
      return snap.offset <= radius ? [{ ...place, along: snap.along, offset: snap.offset }] : [];
    }).sort((a, b) => a.along - b.along);
  }
  function mergePlaces(guide, live, blocked = []) {
    const denied = new Set(blocked), places = new Map();
    for (const place of [...guide, ...live]) {
      if (denied.has(place.id)) continue;
      const old = places.get(place.id);
      if (!old) { places.set(place.id, { ...place }); continue; }
      // Keep the guide's descriptive name and sources while preferring current map facility evidence.
      const facilityEvidence = { ...old.facilityEvidence };
      for (const type of place.facilities) facilityEvidence[type] = place.facilityEvidence?.[type] || 'mapped';
      places.set(place.id, { ...old, ...place, name: old.source === 'guide' ? old.name : place.name, source: old.source === 'guide' ? 'guide' : place.source, facilities: [...new Set([...old.facilities, ...place.facilities])], facilityEvidence, sources: old.sources || place.sources });
    }
    return [...places.values()].sort((a, b) => a.along - b.along);
  }
  function suggestStops(places, totalMeters, speed, intervalHours = 2.5) {
    if (totalMeters / 1000 / speed < 2.5) return [];
    const pace = speed * 1000, interval = pace * intervalHours;
    const candidates = places.filter(p => !p.unavailable && p.kind !== 'terminal' && p.along >= pace * .5 && p.along <= totalMeters - pace * .5);
    const selected = [];
    let last = 0;
    while (last + interval < totalMeters - pace * .5 && selected.length < 8) {
      const target = last + interval;
      const eligible = candidates.filter(p => p.along >= last + pace * .9 && p.along <= target + pace * 1.25 && !selected.some(s => s.id === p.id));
      if (!eligible.length) break;
      const score = p => Math.abs(p.along - target) / interval + (p.kind === 'rest' ? 0 : .06) + (p.busEvidence === 'unverified' ? .1 : 0) + p.offset / 10000;
      eligible.sort((a, b) => score(a) - score(b) || a.along - b.along || a.id.localeCompare(b.id));
      const best = eligible[0];
      selected.push({ ...best, drivingMinutes: best.along / pace * 60, legMinutes: (best.along - last) / pace * 60 });
      last = best.along;
    }
    return selected;
  }
  const geoFunctions = [distance, projection, segmentDistance, simplify, buildIndex, nearest, pointInRing, centerOf, ringsOf, usable, facilities, classifyPlaces, overpassQuery, guidePlaces];
  const geoConstants = { inPhilippines, named, siteKind, busAccess, stopoverName, foodAmenity, abortError, pause };
  function workerSource() {
    return '\'use strict\';\nconst GUIDE_PLACES = ' + JSON.stringify(GUIDE_PLACES) + ';\n' + Object.entries(geoConstants).map(([name, fn]) => `const ${name} = ${fn.toString()};`).join('\n') + '\n' + geoFunctions.map(fn => fn.toString()).join('\n') + `
      let index, indexKey;
      self.onmessage = async ({ data }) => {
        try {
          const { mode, args } = data;
          let result;
          if (mode === 'line') result = simplify(args.coordinates, 15);
          else if (mode === 'query') result = overpassQuery(args.coordinates, args.radius);
          else if (mode === 'guide') result = guidePlaces(args.coordinates, args.radius);
          else {
            if (indexKey !== args.key) { index = buildIndex(args.coordinates); indexKey = args.key; }
            result = await classifyPlaces(args.elements, index, args.radius);
          }
          self.postMessage({ result });
        } catch (error) { self.postMessage({ error: error.message }); }
      };`;
  }
  async function geoTask(mode, args, signal) {
    if (signal?.aborted) throw abortError();
    // A task owns its worker. Cancelling a trip also stops its CPU work immediately.
    if (typeof Worker !== 'undefined') {
      let worker, url;
      try {
        url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
        worker = new Worker(url);
      } catch { if (url) URL.revokeObjectURL(url); }
      if (worker) {
        try {
          return await new Promise((resolve, reject) => {
            const abort = () => reject(abortError());
            signal?.addEventListener('abort', abort, { once: true });
            worker.onmessage = ({ data }) => { signal?.removeEventListener('abort', abort); data.error ? reject(new Error(data.error)) : resolve(data.result); };
            worker.onerror = () => { signal?.removeEventListener('abort', abort); reject(new Error('Background map processing could not start. Reload the page and try again.')); };
            worker.postMessage({ mode, args });
          });
        } finally { worker.terminate(); URL.revokeObjectURL(url); }
      }
    }
    if (mode === 'line') return simplify(args.coordinates, 15);
    if (mode === 'query') return overpassQuery(args.coordinates, args.radius);
    if (mode === 'guide') return guidePlaces(args.coordinates, args.radius);
    await pause(0, signal);
    return classifyPlaces(args.elements, buildIndex(args.coordinates), args.radius, signal);
  }
  function invalidateRoute() {
    state.generation++;
    state.controller?.abort();
    state.stopController?.abort();
    state.stopGeneration++;
    state.route = null; state.index = null; state.stops = []; state.selected.clear(); state.manual = [];
    state.routeCacheKey = ''; state.stopPhase = 'idle'; state.retainedStops = [];
    $('manual-list').replaceChildren(); $('stops-list').replaceChildren(); $('stop-count').textContent = '0';
    routeLayer?.clearLayers(); stopLayer?.clearLayers(); stopMarkers.clear();
    $('trip-result').hidden = true; $('stopovers').hidden = true;
    $('compact-time').textContent = 'Plan your trip';
    $('compact-detail').textContent = 'Choose your origin and destination';
    setBusy(false);
    status();
  }
  function drawEndpoints() {
    if (!map) return;
    endpointLayer.clearLayers();
    for (const [key, letter] of [['origin', 'A'], ['destination', 'B']]) {
      const point = state[key];
      if (!point) continue;
      const content = element('div', `endpoint-marker ${key === 'destination' ? 'b' : ''}`, letter);
      L.marker([point.lat, point.lon], { icon: L.divIcon({ html: content, className: '', iconSize: [30, 30], iconAnchor: [15, 15] }), title: point.label, alt: `${letter}: ${point.label}` }).bindPopup(element('div', '', point.label)).addTo(endpointLayer);
    }
  }
  function hideResults(key) { $(`${key}-results`).hidden = true; $(key).setAttribute('aria-expanded', 'false'); }
  function setEndpoint(key, point, pan = true) {
    state.searchVersions[key]++;
    state.searchControllers[key]?.abort();
    state.locationVersion++;
    invalidateRoute();
    state[key] = point;
    $(key).value = point.label;
    hideResults(key);
    drawEndpoints();
    if (pan && map) map.setView([point.lat, point.lon], 13);
  }
  function endPicking() {
    state.picking = null;
    $('pick-banner').hidden = true;
    if (map) map.getContainer().style.cursor = '';
  }
  function setSheet(value) {
    state.sheet = value;
    $('planner').dataset.sheet = value;
    $('sheet-toggle').setAttribute('aria-expanded', String(value !== 'collapsed'));
    $('sheet-label').textContent = value === 'expanded' ? 'Collapse trip planner' : 'Expand trip planner';
    const mobile = window.matchMedia('(max-width: 767px)').matches;
    const heights = { collapsed: 'calc(124px + env(safe-area-inset-bottom, 0px))', half: '55dvh', expanded: 'calc(100dvh - 80px - env(safe-area-inset-top, 0px))' };
    document.documentElement.style.setProperty('--map-bottom', mobile ? heights[value] : '0px');
  }
  function fitRoute() {
    if (!map) return;
    const mobile = window.matchMedia('(max-width: 767px)').matches;
    if (mobile && state.sheet === 'expanded') setSheet('half');
    const points = state.route ? state.route.geometry.coordinates.map(c => [c[1], c[0]]) : [state.origin, state.destination].filter(Boolean).map(p => [p.lat, p.lon]);
    if (!points.length) return;
    const sheetHeight = mobile ? Math.min(window.innerHeight * .55, $('planner').getBoundingClientRect().height) : 0;
    map.fitBounds(L.latLngBounds(points), { paddingTopLeft: mobile ? [30, 30] : [465, 30], paddingBottomRight: mobile ? [65, sheetHeight + 35] : [80, 45], maxZoom: 14, animate: false });
  }
  function initMap() {
    if (!window.L) {
      $('map-message').textContent = 'The map library could not load. Check your connection and reload. Route estimates can still be calculated.';
      $('map-message').hidden = false;
      document.querySelectorAll('[data-pick],#fit-route,#zoom-in,#zoom-out').forEach(b => { b.disabled = true; });
      return;
    }
    map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true, minZoom: 5 }).setView([15.7, 121], 7);
    map.attributionControl.setPrefix(false);
    tileLayer = L.tileLayer(SERVICES.tiles, { maxZoom: 19, keepBuffer: 1, updateWhenIdle: true, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    let errors = 0;
    tileLayer.on('tileerror', () => {
      if (++errors < 3) return;
      const box = $('map-message');
      box.replaceChildren(element('span', '', 'Map tiles are unavailable. Your route estimate still works.'));
      const retry = element('button', '', 'Retry map');
      retry.type = 'button';
      retry.addEventListener('click', () => { errors = 0; box.hidden = true; tileLayer.redraw(); });
      box.append(retry); box.hidden = false;
    });
    tileLayer.on('tileload', () => { errors = 0; $('map-message').hidden = true; });
    routeLayer = L.layerGroup().addTo(map);
    stopLayer = L.layerGroup().addTo(map);
    endpointLayer = L.layerGroup().addTo(map);
    map.on('click', event => {
      if (!state.picking) return;
      const { lat, lng } = event.latlng;
      if (!inPhilippines(lng, lat)) { toast('Choose a point in the Philippines.'); return; }
      const key = state.picking;
      setEndpoint(key, { lat, lon: lng, label: `Map pin · ${lat.toFixed(4)}, ${lng.toFixed(4)}` }, false);
      endPicking(); setSheet('half');
      toast(`${key === 'origin' ? 'Origin' : 'Destination'} pinned. Tap Find my route when ready.`);
    });
  }
  async function searchPlaces(key) {
    const query = $(key).value.trim();
    if (query.length < 3) { toast('Enter at least 3 characters, or choose a point on the map.'); return; }
    state.searchControllers[key]?.abort();
    const controller = new AbortController();
    state.searchControllers[key] = controller;
    const version = ++state.searchVersions[key], box = $(`${key}-results`);
    box.replaceChildren(element('p', '', 'Looking for places…')); box.hidden = false;
    $(key).setAttribute('aria-expanded', 'true');
    if (window.matchMedia('(max-width: 767px)').matches) setSheet('expanded');
    const cacheKey = `search:${query.toLowerCase()}`;
    try {
      let results = readCache(cacheKey);
      if (!results) {
        // Explicit submissions only. A single shared queue also avoids simultaneous endpoint searches.
        const job = searchQueue.catch(() => {}).then(async () => {
          await pause(Math.max(0, searchNextAt - Date.now()), controller.signal);
          searchNextAt = Date.now() + 1100;
          const url = new URL(SERVICES.search);
          url.search = new URLSearchParams({ q: query, limit: '8', lang: 'en', bbox: '116,4.2,127.5,21.5', lat: '15', lon: '121' }).toString();
          const data = await fetchJSON(url, {}, controller.signal, 12000);
          return (data.features || []).map(feature => {
            const p = feature.properties || {}, [lon, lat] = feature.geometry?.coordinates || [];
            return { lon, lat, label: [p.name, p.street, p.city || p.town || p.village, p.state].filter((x, i, a) => x && a.indexOf(x) === i).join(', '), country: p.countrycode };
          }).filter(p => inPhilippines(p.lon, p.lat) && (!p.country || p.country.toLowerCase() === 'ph') && p.label).slice(0, 6);
        });
        searchQueue = job;
        results = await job;
        if (controller.signal.aborted || version !== state.searchVersions[key]) return;
        writeCache(cacheKey, results);
      }
      if (controller.signal.aborted || version !== state.searchVersions[key]) return;
      box.replaceChildren();
      if (!results.length) box.append(element('p', '', 'No matching Philippine places. Try the town or terminal name, or choose a point on the map.'));
      for (const point of results) {
        const button = element('button', 'search-result', point.label);
        button.type = 'button';
        button.addEventListener('click', () => { setEndpoint(key, point); $(key === 'origin' ? 'destination' : 'plan-button').focus(); });
        box.append(button);
      }
    } catch (error) {
      if (isAbort(error) || version !== state.searchVersions[key]) return;
      box.replaceChildren(element('p', '', error.httpStatus === 429 ? error.message : 'Place search is unavailable. Try again, or choose a point on the map.'));
    }
  }
  async function planTrip() {
    endPicking();
    if (!state.origin || !state.destination) {
      status('Choose both places from search results, use My location, or pin them on the map.', true);
      (!state.origin ? $('origin') : $('destination')).focus(); return;
    }
    const a = state.origin, b = state.destination;
    if (distance([a.lon, a.lat], [b.lon, b.lat]) < 100) { status('Choose two different places at least 100 m apart.', true); return; }
    if (state.fetching) return;
    invalidateRoute();
    const generation = ++state.generation;
    const controller = new AbortController(); state.controller = controller;
    setBusy(true); status('Finding a road route…');
    const coordinateString = `${a.lon.toFixed(6)},${a.lat.toFixed(6)};${b.lon.toFixed(6)},${b.lat.toFixed(6)}`;
    const cacheKey = `route:${coordinateString}`;
    try {
      let route = readCache(cacheKey);
      if (!route) {
        const data = await fetchJSON(`${SERVICES.route}${coordinateString}?overview=full&geometries=geojson&steps=false&alternatives=false&radiuses=2000;2000`, {}, controller.signal, 18000);
        if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.code === 'NoRoute' ? 'No road route found. Try pins on the same connected road network.' : 'These points could not be connected to a road. Move the pins closer to a road or terminal.');
        const r = data.routes[0], coordinates = r.geometry?.coordinates;
        if (!Number.isFinite(r.distance) || r.distance <= 0 || !Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 150000 || coordinates.some(c => !inPhilippines(c[0], c[1]))) throw new Error('The routing service returned an unsupported route. Try a shorter trip within the Philippines.');
        if (r.distance / 1000 > MAX_ROUTE_KM) throw new Error('Plan trips up to 1,800 km at a time. Split this journey into shorter sections.');
        route = { distance: r.distance, duration: r.duration, geometry: r.geometry, snapped: (data.waypoints || []).map(w => w.distance || 0) };
        if (controller.signal.aborted || generation !== state.generation) return;
        writeCache(cacheKey, route);
      }
      if (generation !== state.generation || controller.signal.aborted) return;
      state.route = route; state.routeCacheKey = cacheKey;
      state.index = null;
      if (map) {
        const simplified = await geoTask('line', { coordinates: route.geometry.coordinates }, controller.signal);
        if (generation !== state.generation || controller.signal.aborted) return;
        const line = simplified.map(c => [c[1], c[0]]);
        L.polyline(line, { color: '#fff', weight: 9, opacity: .9, interactive: false }).addTo(routeLayer);
        L.polyline(line, { color: '#165d4b', weight: 5, opacity: 1, interactive: false }).addTo(routeLayer);
      }
      $('trip-result').hidden = false; $('stopovers').hidden = false;
      updateEstimate(); setBusy(false);
      if (window.matchMedia('(max-width: 767px)').matches) setSheet('half');
      fitRoute();
      status(route.snapped?.some(d => d > 300) ? 'One or both pins were moved more than 300 m to reach a road. Check the route endpoints on the map.' : 'Route ready. Add the breaks your bus will take.');
      $('trip-result').scrollIntoView({ behavior: 'instant', block: 'start' });
      void loadStops();
    } catch (error) {
      if (isAbort(error) || generation !== state.generation) return;
      status(error instanceof TypeError ? 'Could not reach the routing service. Check your connection and try again.' : error.message, true);
      toast('No route was calculated. You can edit the endpoints and retry.');
    } finally {
      if (generation === state.generation) setBusy(false);
    }
  }
  function updateEstimate() {
    if (!state.route) return;
    const breaks = [...state.selected.values()].reduce((a, b) => a + b, 0) + state.manual.reduce((sum, b) => sum + b.minutes, 0);
    const total = state.route.distance / 1000 / state.speed * 60 + breaks;
    const dateValue = $('departure').value;
    const date = dateValue ? new Date(dateValue) : new Date();
    const departure = Number.isFinite(date.getTime()) ? date : new Date();
    const arrival = new Date(departure.getTime() + Math.ceil(total) * 60000);
    const time = arrival.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    const day = arrival.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    $('trip-duration').textContent = duration(total);
    $('trip-distance').textContent = kmText(state.route.distance);
    $('trip-breaks').textContent = duration(breaks);
    $('trip-arrival').textContent = time;
    $('arrival-date').textContent = `${day} · ${zone} · ${dateValue ? 'chosen departure' : 'leaving now'}`;
    $('compact-time').textContent = `${duration(total)} · arrive ${time}`;
    const count = state.selected.size + state.manual.length;
    $('compact-detail').textContent = `${kmText(state.route.distance)} · ${count} break${count === 1 ? '' : 's'} · ${duration(breaks)} stopped`;
    $('selected-count').textContent = count ? `${count} break${count === 1 ? '' : 's'} · ${duration(breaks)}` : 'No breaks added';
    renderSuggestions();
  }
  async function loadStops() {
    if (!state.route) return;
    state.stopController?.abort();
    const controller = new AbortController(); state.stopController = controller;
    const version = ++state.stopGeneration, generation = state.generation;
    const route = state.route, radius = Number($('radius').value), retained = state.stops;
    const denied = new Set();
    const current = () => version === state.stopGeneration && generation === state.generation && !controller.signal.aborted;
    const cacheKey = `stops:${state.routeCacheKey}:${radius}`;
    state.stopPhase = 'loading';
    $('stop-status').textContent = 'Matching stopovers to your road route…';
    let guide = [];
    const display = live => {
      state.stops = mergePlaces(guide, live);
      for (const place of retained) if (state.selected.has(place.id) && !state.stops.some(p => p.id === place.id)) state.stops.push(denied.has(place.id) ? { ...place, unavailable: true, evidence: 'Live map marks this place closed or restricted. Remove or replace this break.' } : place);
      state.stops.sort((a, b) => a.along - b.along);
      state.retainedStops = state.stops;
      state.visible = 24;
      renderStops(); renderStopMarkers();
    };
    try {
      guide = await geoTask('guide', { coordinates: route.geometry.coordinates, radius }, controller.signal);
      if (!current()) return;
      display([]);
      $('stop-status').textContent = guide.length ? `${guide.length} source-linked places from the starter guide. Checking live map data for more…` : 'Looking for mapped rest sites and bus-accessible facilities…';
      let payload = readCache(cacheKey), cached = Boolean(payload);
      if (!payload) {
        if (state.stopRetryAt > Date.now()) throw new Error('The map service asked us to wait before retrying.');
        const query = await geoTask('query', { coordinates: route.geometry.coordinates, radius }, controller.signal);
        let data, lastError;
        for (let i = 0; i < SERVICES.overpass.length; i++) {
          if (controller.signal.aborted) throw abortError();
          try {
            const response = await fetchJSON(SERVICES.overpass[i], { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ data: query }).toString() }, controller.signal, 16000);
            if (response.remark || !Array.isArray(response.elements)) throw new Error('The map service could not complete this search.');
            data = response; break;
          } catch (error) {
            if (isAbort(error)) throw error;
            lastError = error;
            if ([429, 406].includes(error.httpStatus)) { state.stopRetryAt = Date.now() + 30000; throw error; }
            if (i + 1 < SERVICES.overpass.length && current()) $('stop-status').textContent = guide.length ? 'Starter-guide suggestions are ready. Trying another live map service…' : 'The first map service is busy. Trying another…';
          }
        }
        if (!data) throw lastError || new Error('Stopover search is unavailable.');
        if (data.elements.length > 30000) throw new Error('Too many map results. Try a shorter route.');
        const places = await geoTask('classify', { elements: data.elements, coordinates: route.geometry.coordinates, key: state.routeCacheKey, radius }, controller.signal);
        payload = { places, blocked: data.elements.filter(p => p.tags && !usable(p.tags)).map(p => `${p.type}/${p.id}`) };
        if (!current()) return;
        writeCache(cacheKey, payload);
      }
      if (!current()) return;
      for (const id of payload.blocked) denied.add(id);
      guide = guide.filter(p => !denied.has(p.id));
      display(payload.places);
      state.stopPhase = 'ready';
      const guideCount = state.stops.filter(p => p.source === 'guide').length;
      $('stop-status').textContent = `${state.stops.length} places along your route · ${guideCount} starter-guide places${cached ? ' · cached map results' : ''}. Check opening hours and your operator’s stops.`;
      if (!state.stops.length) $('stop-status').textContent = 'No suitable places are mapped here. Add a known break below.';
      renderStops();
    } catch (error) {
      if (isAbort(error) || !current()) return;
      state.stopPhase = 'error';
      const message = guide.length ? 'Live map search is unavailable. The source-linked starter-guide places below are still usable; their current facilities and bus access are unverified.' : 'Live stopover search is unavailable. Your road estimate and manual breaks still work.';
      $('stop-status').replaceChildren(element('span', '', message + ' '));
      const retry = element('button', '', 'Retry live search'); retry.type = 'button';
      retry.addEventListener('click', () => { void loadStops(); }); $('stop-status').append(retry);
      renderStops();
    }
  }
  function renderSuggestions() {
    if (!state.route) return;
    const suggestions = suggestStops(state.stops, state.route.distance, state.speed, Number($('break-interval').value));
    const box = $('suggestions-list'), fragment = document.createDocumentFragment();
    $('suggestions-panel').hidden = !suggestions.length;
    for (const stop of suggestions) {
      const card = element('article', 'suggestion-card');
      card.append(element('span', 'eyebrow', `${duration(stop.drivingMinutes)} into driving · ${kmText(stop.along)}`), element('h3', '', stop.name));
      card.append(element('p', '', `${stop.facilities.includes('food') ? 'Food break' : 'Rest break'} after about ${duration(stop.legMinutes)} of driving${stop.busEvidence === 'unverified' ? ' · confirm coach access' : ''}.`));
      const actions = element('div', 'suggestion-actions'), view = element('button', '', 'View on map ↗'), add = element('button', 'suggestion-add', state.selected.has(stop.id) ? 'Remove break' : `Add ${defaultMinutes(stop)} min`);
      view.type = add.type = 'button';
      view.addEventListener('click', () => { state.filter = 'all'; $('stop-search').value = ''; $('stop-filters').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === 'all'))); renderStops(); renderStopMarkers(); focusStop(stop); });
      add.addEventListener('click', () => { toggleStop(stop, !state.selected.has(stop.id)); renderStops(); });
      actions.append(view, add); card.append(actions); fragment.append(card);
    }
    box.replaceChildren(fragment);
    const missing = suggestions.filter(p => !state.selected.has(p.id));
    $('add-suggestions').disabled = !missing.length;
    $('add-suggestions').textContent = missing.length ? `Add suggested breaks · +${duration(missing.reduce((n, p) => n + defaultMinutes(p), 0))}` : 'Suggested breaks added';
  }
  function defaultMinutes(stop) { return stop.facilities.includes('food') ? 30 : stop.facilities.includes('toilets') ? 10 : stop.kind === 'terminal' ? 5 : 15; }
  function toggleStop(stop, checked) {
    if (checked) state.selected.set(stop.id, state.selected.get(stop.id) || defaultMinutes(stop));
    else state.selected.delete(stop.id);
    updateEstimate(); updateMarker(stop.id);
  }
  function updateMarker(id) {
    const marker = stopMarkers.get(id);
    if (marker) marker.setStyle({ radius: state.selected.has(id) ? 7 : 5, fillColor: state.selected.has(id) ? '#165d4b' : '#fff', color: state.selected.has(id) ? '#165d4b' : '#a96b32', weight: 2, fillOpacity: 1 });
  }
  function stopMatches(stop) {
    const filter = state.filter, query = $('stop-search').value.trim().toLocaleLowerCase();
    return (!query || stop.name.toLocaleLowerCase().includes(query)) && (filter === 'all' || stop.facilities.includes(filter) || stop.kind === filter);
  }
  function renderStopMarkers() {
    if (!map) return;
    stopLayer.clearLayers(); stopMarkers.clear();
    for (const stop of state.stops) {
      if (!stopMatches(stop)) continue;
      const marker = L.circleMarker([stop.coordinate[1], stop.coordinate[0]], { radius: 5 }).addTo(stopLayer);
      stopMarkers.set(stop.id, marker); updateMarker(stop.id);
      marker.bindPopup(() => {
        const popup = element('div');
        popup.append(element('strong', '', stop.name), element('div', '', `${kmText(stop.along)} along route · ${Math.round(stop.offset)} m from route`));
        const button = element('button', '', state.selected.has(stop.id) ? 'Remove break' : `Add ${defaultMinutes(stop)} min break`); button.type = 'button';
        button.addEventListener('click', () => { toggleStop(stop, !state.selected.has(stop.id)); renderStops(); map.closePopup(); });
        popup.append(button); return popup;
      });
    }
  }
  function focusStop(stop) {
    if (!map) { toast('The map is unavailable. This stop is still included in the estimate when selected.'); return; }
    setSheet('collapsed');
    const mobile = window.matchMedia('(max-width: 767px)').matches;
    const zoom = 15, projected = map.project([stop.coordinate[1], stop.coordinate[0]], zoom);
    // Offset the map center so the marker sits in the uncovered map area.
    const center = mobile ? projected.add([0, $('planner').getBoundingClientRect().height / 2]) : projected.subtract([220, 0]);
    map.setView(map.unproject(center, zoom), zoom, { animate: false });
    stopMarkers.get(stop.id)?.openPopup();
  }
  function renderStops() {
    renderSuggestions();
    const list = $('stops-list'), fragment = document.createDocumentFragment();
    const visible = state.stops.filter(stopMatches);
    $('stop-count').textContent = String(state.stops.length);
    if (!visible.length) {
      const text = state.stopPhase === 'loading' ? 'Your route is ready while we look for stopovers.' : state.stopPhase === 'error' ? 'You can add a known break below while map search is unavailable.' : state.filter === 'all' && !$('stop-search').value ? 'No mapped bus stopover candidates found. Add a known break below.' : 'No mapped places match this filter. Try another category or add a known break.';
      fragment.append(element('p', 'stop-empty', text));
    }
    for (const stop of visible.slice(0, state.visible)) {
      const card = element('article', `stop-card${state.selected.has(stop.id) ? ' selected' : ''}`);
      const label = element('label', 'stop-main'), checkbox = element('input');
      checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(stop.id);
      checkbox.setAttribute('aria-label', `Add break at ${stop.name}`);
      const info = element('div', 'stop-info');
      info.append(element('strong', '', stop.name), element('p', 'stop-meta', `${kmText(stop.along)} into trip · ${Math.round(stop.offset)} m off route`), element('p', 'stop-meta', stop.evidence));
      const tags = element('div', 'facility-tags');
      const tagNames = { food: stop.facilityEvidence?.food === 'listed' ? 'Food listed' : 'Food mapped', toilets: stop.facilityEvidence?.toilets === 'reported' ? 'Toilets reported' : 'Toilets mapped', rest: stop.source === 'guide' ? 'Travel stop' : 'Rest area', terminal: 'Terminal' };
      for (const tag of [stop.kind, ...stop.facilities]) if (tagNames[tag]) tags.append(element('span', '', tagNames[tag]));
      info.append(tags); label.append(checkbox, info); card.append(label);
      const actions = element('div', 'stop-actions'), view = element('button', '', 'View on map ↗'); view.type = 'button';
      view.addEventListener('click', () => focusStop(stop));
      const durationLabel = element('label', '', 'Break'), select = element('select');
      select.setAttribute('aria-label', `Break duration at ${stop.name}`);
      for (const n of [5, 10, 15, 20, 30, 45, 60, 90, 120]) {
        const option = element('option', '', `${n} min`); option.value = String(n);
        select.append(option);
      }
      select.value = String(state.selected.get(stop.id) || defaultMinutes(stop));
      checkbox.addEventListener('change', () => {
        toggleStop(stop, checkbox.checked);
        if (checkbox.checked) { state.selected.set(stop.id, Number(select.value)); updateEstimate(); }
        card.classList.toggle('selected', checkbox.checked);
      });
      select.addEventListener('change', () => {
        checkbox.checked = true; state.selected.set(stop.id, Number(select.value));
        card.classList.add('selected'); updateEstimate(); updateMarker(stop.id);
      });
      durationLabel.append(select); actions.append(view, durationLabel); card.append(actions);
      if (stop.sources?.length) {
        const details = element('details', 'place-sources');
        details.append(element('summary', '', `Starter guide · sources checked ${stop.checked || '2026-10-25'}`));
        for (const source of stop.sources) {
          const link = element('a', '', source.label + ' ↗'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link);
        }
        details.append(element('p', '', 'Traveler reports can be old. Confirm current opening hours, facilities, and your bus operator’s stop list.'));
        card.append(details);
      }
      fragment.append(card);
    }
    list.replaceChildren(fragment);
    $('more-stops').hidden = visible.length <= state.visible;
    if (!$('more-stops').hidden) $('more-stops').textContent = `Show more places (${visible.length - state.visible} remaining)`;
  }
  function renderManual() {
    const fragment = document.createDocumentFragment();
    state.manual.forEach(stop => {
      const row = element('div', 'manual-item'); row.append(element('span', '', `${stop.name} · ${stop.minutes} min`));
      const remove = element('button', '', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${stop.name}`);
      remove.addEventListener('click', () => { state.manual = state.manual.filter(s => s.id !== stop.id); renderManual(); updateEstimate(); });
      row.append(remove); fragment.append(row);
    });
    $('manual-list').replaceChildren(fragment);
  }
  function bindEvents() {
    $('trip-form').addEventListener('submit', event => { event.preventDefault(); void planTrip(); });
    for (const key of ['origin', 'destination']) {
      $(key).addEventListener('input', () => {
        state.searchControllers[key]?.abort(); state.searchVersions[key]++; state.locationVersion++;
        hideResults(key);
        if (state[key]) { state[key] = null; invalidateRoute(); drawEndpoints(); }
      });
      $(key).addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); void searchPlaces(key); }
        if (event.key === 'Escape') { hideResults(key); endPicking(); }
        if (event.key === 'ArrowDown' && !$(`${key}-results`).hidden) { event.preventDefault(); $(`${key}-results`).querySelector('button')?.focus(); }
      });
      $(`${key}-results`).addEventListener('keydown', event => {
        const buttons = [...$(`${key}-results`).querySelectorAll('button')], i = buttons.indexOf(document.activeElement);
        if (event.key === 'Escape') { hideResults(key); $(key).focus(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
      });
    }
    document.querySelectorAll('[data-search]').forEach(button => button.addEventListener('click', () => { void searchPlaces(button.dataset.search); }));
    document.querySelectorAll('[data-pick]').forEach(button => button.addEventListener('click', () => {
      if (!map) return;
      state.locationVersion++;
      state.picking = button.dataset.pick;
      $('pick-label').textContent = `Tap the map for your ${state.picking === 'origin' ? 'origin' : 'destination'}.`;
      $('pick-banner').hidden = false; map.getContainer().style.cursor = 'crosshair';
      setSheet('collapsed');
    }));
    document.querySelectorAll('[data-locate]').forEach(button => button.addEventListener('click', () => {
      if (!navigator.geolocation) { toast('Location is unavailable. Search for a place or choose a point on the map.'); return; }
      const version = ++state.locationVersion, key = button.dataset.locate;
      button.disabled = true; toast('Waiting for your location permission…');
      navigator.geolocation.getCurrentPosition(position => {
        button.disabled = false;
        if (version !== state.locationVersion) return;
        const { latitude: lat, longitude: lon, accuracy } = position.coords;
        if (!inPhilippines(lon, lat)) { toast('Your location is outside the Philippines. Search for a Philippine place instead.'); return; }
        setEndpoint(key, { lon, lat, label: `My location · ${lat.toFixed(4)}, ${lon.toFixed(4)}` });
        toast(`Location set${accuracy > 250 ? `, accurate to about ${Math.round(accuracy)} m. Check the pin.` : '.'}`);
      }, error => { button.disabled = false; if (version === state.locationVersion) toast(error.code === 1 ? 'Location permission was denied. Search or pin a place instead.' : 'Could not get your location. Search or pin a place instead.'); }, { timeout: 12000, maximumAge: 60000, enableHighAccuracy: false });
    }));
    $('cancel-pick').addEventListener('click', () => { endPicking(); setSheet('half'); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.picking) { endPicking(); setSheet('half'); } });
    $('swap').addEventListener('click', () => {
      endPicking(); state.locationVersion++;
      for (const key of ['origin', 'destination']) { state.searchControllers[key]?.abort(); state.searchVersions[key]++; hideResults(key); }
      const origin = state.destination, destination = state.origin;
      invalidateRoute(); state.origin = origin; state.destination = destination;
      $('origin').value = origin?.label || ''; $('destination').value = destination?.label || ''; drawEndpoints();
    });
    $('sample').addEventListener('click', () => {
      setEndpoint('origin', { lat: 14.5081487, lon: 120.9912389, label: 'PITX, Parañaque' }, false);
      setEndpoint('destination', { lat: 13.1434331, lon: 123.7456441, label: 'Legazpi Grand Central Terminal' }, false);
      $('profile').value = 'provincial'; setSpeed(60); void planTrip();
    });
    $('break-interval').addEventListener('change', renderSuggestions);
    $('add-suggestions').addEventListener('click', () => {
      if (!state.route) return;
      const suggestions = suggestStops(state.stops, state.route.distance, state.speed, Number($('break-interval').value));
      for (const stop of suggestions) if (!state.selected.has(stop.id)) { state.selected.set(stop.id, defaultMinutes(stop)); updateMarker(stop.id); }
      updateEstimate(); renderStops();
    });
    $('profile').addEventListener('change', () => { const speed = PROFILES[$('profile').value]; if (speed) setSpeed(speed); });
    $('speed').addEventListener('input', () => { $('profile').value = 'custom'; setSpeed(Number($('speed').value)); });
    $('departure').addEventListener('change', updateEstimate);
    $('radius').addEventListener('change', () => { if (state.route) { state.retainedStops = state.stops; void loadStops(); } });
    $('fit-route').addEventListener('click', fitRoute);
    $('zoom-in').addEventListener('click', () => map?.zoomIn()); $('zoom-out').addEventListener('click', () => map?.zoomOut());
    $('sheet-toggle').addEventListener('click', () => setSheet(state.sheet === 'expanded' ? 'half' : 'expanded'));
    let pointerStart = null, dragged = false;
    $('sheet-toggle').addEventListener('pointerdown', event => { pointerStart = event.clientY; dragged = false; $('sheet-toggle').setPointerCapture?.(event.pointerId); });
    $('sheet-toggle').addEventListener('pointerup', event => {
      if (pointerStart === null) return;
      const delta = event.clientY - pointerStart; pointerStart = null;
      if (Math.abs(delta) < 20) return;
      dragged = true;
      setSheet(delta < 0 ? 'expanded' : state.sheet === 'expanded' ? 'half' : 'collapsed');
    });
    $('sheet-toggle').addEventListener('click', event => { if (dragged) { event.stopImmediatePropagation(); dragged = false; } }, true);
    $('sheet-toggle').addEventListener('pointercancel', () => { pointerStart = null; });
    window.addEventListener('resize', () => { setSheet(state.sheet); map?.invalidateSize({ pan: false }); });
    $('stop-filters').addEventListener('click', event => {
      const button = event.target.closest('[data-filter]'); if (!button) return;
      state.filter = button.dataset.filter; state.visible = 24;
      $('stop-filters').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      renderStops(); renderStopMarkers();
    });
    let filterTimer;
    $('stop-search').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { state.visible = 24; renderStops(); renderStopMarkers(); }, 120); });
    $('more-stops').addEventListener('click', () => { state.visible += 24; renderStops(); });
    $('clear-stops').addEventListener('click', () => { state.selected.clear(); state.manual = []; renderStops(); renderManual(); updateEstimate(); for (const id of stopMarkers.keys()) updateMarker(id); });
    $('add-manual').addEventListener('click', () => {
      if (!state.route) return;
      const minutes = Number($('manual-minutes').value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) { toast('Choose a whole number from 1 to 240 minutes.'); $('manual-minutes').focus(); return; }
      if (state.manual.length >= 30) { toast('You can add up to 30 manual breaks per trip.'); return; }
      state.manual.push({ id: `${Date.now()}-${Math.random()}`, name: $('manual-name').value.trim() || 'Unmapped break', minutes });
      $('manual-name').value = ''; renderManual(); updateEstimate(); toast(`${minutes} min break added.`);
    });
    $('clear-cache').addEventListener('click', () => {
      state.locationVersion++; endPicking();
      for (const key of ['origin', 'destination']) { state.searchControllers[key]?.abort(); state.searchVersions[key]++; hideResults(key); }
      invalidateRoute(); memoryCache.clear();
      try { Object.keys(sessionStorage).filter(k => k.startsWith('transitcorridor:')).forEach(k => sessionStorage.removeItem(k)); } catch { /* Storage may be disabled. */ }
      state.origin = null; state.destination = null; state.retainedStops = [];
      $('origin').value = ''; $('destination').value = ''; $('departure').value = ''; $('manual-name').value = ''; $('stop-search').value = '';
      renderManual(); drawEndpoints(); toast('Trip and cached searches cleared from this tab.');
    });
    document.addEventListener('click', event => { if (!event.target.closest('.waypoint')) { hideResults('origin'); hideResults('destination'); } });
    window.addEventListener('online', () => toast('Back online. You can retry your search.'));
    window.addEventListener('offline', () => toast('You are offline. Cached trips and local time estimates still work.'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('departure').value) updateEstimate(); });
  }
  function setSpeed(value) { state.speed = value; $('speed').value = String(value); $('speed-value').textContent = `${value} km/h`; updateEstimate(); }
  function init() { initMap(); bindEvents(); setSheet('half'); }
  init();
})();
