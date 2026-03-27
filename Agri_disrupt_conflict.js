/**************************************************************
 SOMALIA AGRICULTURAL CALENDAR DISRUPTION ANALYSIS
 Conflict + displacement impacts on cropping calendar
 Google Earth Engine JavaScript API

 PURPOSE
 Show how conflict and displacement affect:
 - land preparation
 - sowing
 - crop development
 - harvesting

 FOCUS
 NOT yield loss.
 Instead:
 identify agricultural areas where conflict/displacement
 likely delayed or disrupted seasonal farming activities.

 DATA NEEDED
 1. ACLED Somalia as GEE table asset
 2. IOM DTM Somalia ETT as GEE table asset

 IMPORTANT
 - Replace asset IDs below
 - DTM Excel should be exported to CSV before upload
**************************************************************/

// =====================================================
// 1. USER SETTINGS
// =====================================================
var SETTINGS = {
  targetYear: 2024,
  scale: 10,
  riskBufferMeters: 5000,

  // Replace with your own assets
  acledAsset: 'projects/studious-legend-447918-u1/assets/ACLED_Somalia_2024_2025',
  dtmAsset: 'projects/studious-legend-447918-u1/assets/IOM_DTM_ETT_Somalia',

  ndviThreshold: 0.40,
  guActiveThreshold: 0.45,
  deyrActiveThreshold: 0.40,

  // Somalia seasonal calendar windows
  // You can adjust these if needed for your study
  gu: {
    landprepStart: '2024-02-01',
    landprepEnd:   '2024-03-31',
    sowingStart:   '2024-04-01',
    sowingEnd:     '2024-05-15',
    growingStart:  '2024-05-16',
    growingEnd:    '2024-07-31',
    harvestStart:  '2024-08-01',
    harvestEnd:    '2024-09-30'
  },

  deyr: {
    landprepStart: '2024-09-01',
    landprepEnd:   '2024-10-15',
    sowingStart:   '2024-10-16',
    sowingEnd:     '2024-11-30',
    growingStart:  '2024-12-01',
    growingEnd:    '2025-01-31',
    harvestStart:  '2025-02-01',
    harvestEnd:    '2025-03-31'
  }
};


// =====================================================
// 2. BOUNDARIES
// =====================================================
var countries = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017');
var somalia = countries.filter(ee.Filter.eq('country_na', 'Somalia')).geometry();

var districts = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM0_NAME', 'Somalia'));

Map.centerObject(somalia, 6);
Map.setOptions('SATELLITE');


// =====================================================
// 3. CROPLAND PRIOR
// =====================================================
var worldcover = ee.ImageCollection('ESA/WorldCover/v200').first();
var cropland = worldcover.select('Map').eq(40).clip(somalia).selfMask();


// =====================================================
// 4. SENTINEL-2 PREP
// =====================================================
function maskS2clouds(img) {
  var qa = img.select('QA60');
  var cloudBitMask = 1 << 10;
  var cirrusBitMask = 1 << 11;

  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
    .and(qa.bitwiseAnd(cirrusBitMask).eq(0));

  return img.updateMask(mask)
    .divide(10000)
    .copyProperties(img, ['system:time_start']);
}

function addNDVI(img) {
  var ndvi = img.normalizedDifference(['B8', 'B4']).rename('NDVI');
  return img.addBands(ndvi);
}

var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(somalia)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40))
  .map(maskS2clouds)
  .map(addNDVI);


// =====================================================
// 5. SEASONAL ACTIVITY MAPS
// =====================================================
function seasonalPeak(startDate, endDate, threshold) {
  var peak = s2
    .filterDate(startDate, endDate)
    .median()
    .select('NDVI')
    .clip(somalia);

  var active = peak.gt(threshold).selfMask().updateMask(cropland);
  return {
    peak: peak,
    active: active
  };
}

// GU agriculture activity
var guSeason = seasonalPeak('2024-03-01', '2024-07-31', SETTINGS.guActiveThreshold);

// DEYR agriculture activity
var deyrSeason = seasonalPeak('2024-10-01', '2025-01-31', SETTINGS.deyrActiveThreshold);

var guActive = guSeason.active;
var deyrActive = deyrSeason.active;
var guPeak = guSeason.peak;
var deyrPeak = deyrSeason.peak;


// =====================================================
// 6. LOAD ACLED
// =====================================================
var acledRaw = ee.FeatureCollection(SETTINGS.acledAsset)
  .filterBounds(somalia);

// Parse ACLED event date
var acled = acledRaw.map(function(f) {
  var date = ee.Date.parse('yyyy-MM-dd', ee.String(f.get('event_date')));
  return f.set('eventDateParsed', date.millis());
});

// Keep main conflict-related event types
var acledConflict = acled.filter(
  ee.Filter.inList('event_type', [
    'Battles',
    'Violence against civilians',
    'Explosions/Remote violence',
    'Riots'
  ])
);


// =====================================================
// 7. LOAD DTM AND BUILD ORIGIN GEOMETRY
// =====================================================
var dtmRaw = ee.FeatureCollection(SETTINGS.dtmAsset)
  .filterBounds(somalia);

function parseMaybeNumber(val) {
  var s = ee.String(ee.Algorithms.If(val, val, ''));
  s = s.replace(',', '');
  s = s.replace(' ', '');
  return ee.Number.parse(s);
}

var dtmPoints = dtmRaw.map(function(f) {
  var originLatStr = ee.String(ee.Algorithms.If(f.get('Orgin latitude'), f.get('Orgin latitude'), ''));
  var originLonStr = ee.String(ee.Algorithms.If(f.get('Orgin longitude'), f.get('Orgin longitude'), ''));
  var currLat = f.get('current latitude');
  var currLon = f.get('current longtiude');

  var hasOriginLat = originLatStr.length().gt(0);
  var hasOriginLon = originLonStr.length().gt(0);
  var hasOrigin = hasOriginLat.and(hasOriginLon);

  var lat = ee.Algorithms.If(hasOrigin, parseMaybeNumber(originLatStr), currLat);
  var lon = ee.Algorithms.If(hasOrigin, parseMaybeNumber(originLonStr), currLon);

  var geom = ee.Geometry.Point([ee.Number(lon), ee.Number(lat)]);

  var dateParsed = ee.Date.parse('M/d/yyyy', ee.String(f.get('Date of Assessment')));

  return ee.Feature(geom, f.toDictionary())
    .set('dtmDateParsed', dateParsed.millis())
    .set('used_origin_geometry', hasOrigin);
});

// Keep conflict displacement only if you want strict conflict-related displacement
var dtmConflict = dtmPoints.filter(
  ee.Filter.eq('Main Cause of Displacement', 'Conflict')
);


// =====================================================
// 8. DATE FILTER FUNCTIONS
// =====================================================
function filterAcledByWindow(fc, startDate, endDate) {
  var start = ee.Date(startDate).millis();
  var end = ee.Date(endDate).millis();
  return fc.filter(ee.Filter.gte('eventDateParsed', start))
           .filter(ee.Filter.lte('eventDateParsed', end));
}

function filterDTMByWindow(fc, startDate, endDate) {
  var start = ee.Date(startDate).millis();
  var end = ee.Date(endDate).millis();
  return fc.filter(ee.Filter.gte('dtmDateParsed', start))
           .filter(ee.Filter.lte('dtmDateParsed', end));
}

function bufferPoints(fc, meters) {
  return fc.map(function(f) {
    return f.buffer(meters).copyProperties(f);
  });
}


// =====================================================
// 9. CALENDAR-SPECIFIC EVENT SETS
// =====================================================

// ---------- GU ----------
var guLandprepConflict = filterAcledByWindow(
  acledConflict, SETTINGS.gu.landprepStart, SETTINGS.gu.landprepEnd
);
var guSowingConflict = filterAcledByWindow(
  acledConflict, SETTINGS.gu.sowingStart, SETTINGS.gu.sowingEnd
);
var guGrowingConflict = filterAcledByWindow(
  acledConflict, SETTINGS.gu.growingStart, SETTINGS.gu.growingEnd
);
var guHarvestConflict = filterAcledByWindow(
  acledConflict, SETTINGS.gu.harvestStart, SETTINGS.gu.harvestEnd
);

var guLandprepDTM = filterDTMByWindow(
  dtmConflict, SETTINGS.gu.landprepStart, SETTINGS.gu.landprepEnd
);
var guSowingDTM = filterDTMByWindow(
  dtmConflict, SETTINGS.gu.sowingStart, SETTINGS.gu.sowingEnd
);
var guGrowingDTM = filterDTMByWindow(
  dtmConflict, SETTINGS.gu.growingStart, SETTINGS.gu.growingEnd
);
var guHarvestDTM = filterDTMByWindow(
  dtmConflict, SETTINGS.gu.harvestStart, SETTINGS.gu.harvestEnd
);

// ---------- DEYR ----------
var deyrLandprepConflict = filterAcledByWindow(
  acledConflict, SETTINGS.deyr.landprepStart, SETTINGS.deyr.landprepEnd
);
var deyrSowingConflict = filterAcledByWindow(
  acledConflict, SETTINGS.deyr.sowingStart, SETTINGS.deyr.sowingEnd
);
var deyrGrowingConflict = filterAcledByWindow(
  acledConflict, SETTINGS.deyr.growingStart, SETTINGS.deyr.growingEnd
);
var deyrHarvestConflict = filterAcledByWindow(
  acledConflict, SETTINGS.deyr.harvestStart, SETTINGS.deyr.harvestEnd
);

var deyrLandprepDTM = filterDTMByWindow(
  dtmConflict, SETTINGS.deyr.landprepStart, SETTINGS.deyr.landprepEnd
);
var deyrSowingDTM = filterDTMByWindow(
  dtmConflict, SETTINGS.deyr.sowingStart, SETTINGS.deyr.sowingEnd
);
var deyrGrowingDTM = filterDTMByWindow(
  dtmConflict, SETTINGS.deyr.growingStart, SETTINGS.deyr.growingEnd
);
var deyrHarvestDTM = filterDTMByWindow(
  dtmConflict, SETTINGS.deyr.harvestStart, SETTINGS.deyr.harvestEnd
);


// =====================================================
// 10. DISRUPTION ZONES
// =====================================================
function makeDisruptionZone(conflictFC, dtmFC) {
  var conflictBuf = bufferPoints(conflictFC, SETTINGS.riskBufferMeters);
  var dtmBuf = bufferPoints(dtmFC, SETTINGS.riskBufferMeters);
  var merged = ee.FeatureCollection(conflictBuf.merge(dtmBuf));

  return ee.Algorithms.If(
    merged.size().gt(0),
    merged.union().geometry(),
    ee.Geometry.MultiPolygon([])
  );
}

// GU zones
var guLandprepZone = ee.Geometry(makeDisruptionZone(guLandprepConflict, guLandprepDTM));
var guSowingZone = ee.Geometry(makeDisruptionZone(guSowingConflict, guSowingDTM));
var guGrowingZone = ee.Geometry(makeDisruptionZone(guGrowingConflict, guGrowingDTM));
var guHarvestZone = ee.Geometry(makeDisruptionZone(guHarvestConflict, guHarvestDTM));

// DEYR zones
var deyrLandprepZone = ee.Geometry(makeDisruptionZone(deyrLandprepConflict, deyrLandprepDTM));
var deyrSowingZone = ee.Geometry(makeDisruptionZone(deyrSowingConflict, deyrSowingDTM));
var deyrGrowingZone = ee.Geometry(makeDisruptionZone(deyrGrowingConflict, deyrGrowingDTM));
var deyrHarvestZone = ee.Geometry(makeDisruptionZone(deyrHarvestConflict, deyrHarvestDTM));

function zoneToImage(zone) {
  return ee.Image.constant(1).clip(zone).selfMask();
}

var guLandprepZoneImg = zoneToImage(guLandprepZone);
var guSowingZoneImg = zoneToImage(guSowingZone);
var guGrowingZoneImg = zoneToImage(guGrowingZone);
var guHarvestZoneImg = zoneToImage(guHarvestZone);

var deyrLandprepZoneImg = zoneToImage(deyrLandprepZone);
var deyrSowingZoneImg = zoneToImage(deyrSowingZone);
var deyrGrowingZoneImg = zoneToImage(deyrGrowingZone);
var deyrHarvestZoneImg = zoneToImage(deyrHarvestZone);


// =====================================================
// 11. AGRICULTURAL CALENDAR DISRUPTION MAPS
// =====================================================
// These are the key outputs:
// active agricultural areas exposed to conflict/displacement
// during specific farming windows.

var guLandprepDisrupted = guActive.updateMask(guLandprepZoneImg);
var guSowingDisrupted = guActive.updateMask(guSowingZoneImg);
var guGrowingDisrupted = guActive.updateMask(guGrowingZoneImg);
var guHarvestDisrupted = guActive.updateMask(guHarvestZoneImg);

var deyrLandprepDisrupted = deyrActive.updateMask(deyrLandprepZoneImg);
var deyrSowingDisrupted = deyrActive.updateMask(deyrSowingZoneImg);
var deyrGrowingDisrupted = deyrActive.updateMask(deyrGrowingZoneImg);
var deyrHarvestDisrupted = deyrActive.updateMask(deyrHarvestZoneImg);


// =====================================================
// 12. AREA OF DISRUPTION (HECTARES OF CALENDAR EXPOSURE)
// =====================================================
// This is NOT yield loss.
// It is area where agricultural activities were exposed to disruption.

var haImage = ee.Image.pixelArea().divide(10000).rename('ha');

function calcAreaHa(maskImage, geometry) {
  return ee.Number(
    haImage.updateMask(maskImage).reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: geometry,
      scale: SETTINGS.scale,
      maxPixels: 1e13
    }).get('ha')
  );
}

var guLandprepHa = calcAreaHa(guLandprepDisrupted, somalia);
var guSowingHa = calcAreaHa(guSowingDisrupted, somalia);
var guGrowingHa = calcAreaHa(guGrowingDisrupted, somalia);
var guHarvestHa = calcAreaHa(guHarvestDisrupted, somalia);

var deyrLandprepHa = calcAreaHa(deyrLandprepDisrupted, somalia);
var deyrSowingHa = calcAreaHa(deyrSowingDisrupted, somalia);
var deyrGrowingHa = calcAreaHa(deyrGrowingDisrupted, somalia);
var deyrHarvestHa = calcAreaHa(deyrHarvestDisrupted, somalia);


// =====================================================
// 13. DISPLACEMENT FROM ACTIVE AGRICULTURAL AREAS
// =====================================================
function tagPointInCrop(fc, cropMask, outField) {
  return fc.map(function(f) {
    var val = cropMask.rename('crop').reduceRegion({
      reducer: ee.Reducer.first(),
      geometry: f.geometry(),
      scale: SETTINGS.scale,
      maxPixels: 1e9
    }).get('crop');

    return f.set(outField, ee.Algorithms.If(val, 1, 0));
  });
}

var guDTMInAg = tagPointInCrop(guSowingDTM, guActive, 'in_gu_ag')
  .filter(ee.Filter.eq('in_gu_ag', 1));

var deyrDTMInAg = tagPointInCrop(deyrSowingDTM, deyrActive, 'in_deyr_ag')
  .filter(ee.Filter.eq('in_deyr_ag', 1));

var guDisplacedPeople = ee.Number(guDTMInAg.aggregate_sum('Total new arrivals since last week'));
var deyrDisplacedPeople = ee.Number(deyrDTMInAg.aggregate_sum('Total new arrivals since last week'));


// =====================================================
// 14. DISTRICT SUMMARY
// =====================================================
function sumAreaByDistrict(maskImage, districtsFC, outField) {
  var img = ee.Image.pixelArea().divide(10000).rename(outField).updateMask(maskImage);
  return img.reduceRegions({
    collection: districtsFC,
    reducer: ee.Reducer.sum(),
    scale: SETTINGS.scale
  });
}

var guLandprepDistrict = sumAreaByDistrict(guLandprepDisrupted, districts, 'gu_landprep_ha');
var guSowingDistrict = sumAreaByDistrict(guSowingDisrupted, districts, 'gu_sowing_ha');
var guHarvestDistrict = sumAreaByDistrict(guHarvestDisrupted, districts, 'gu_harvest_ha');

var deyrLandprepDistrict = sumAreaByDistrict(deyrLandprepDisrupted, districts, 'deyr_landprep_ha');
var deyrSowingDistrict = sumAreaByDistrict(deyrSowingDisrupted, districts, 'deyr_sowing_ha');
var deyrHarvestDistrict = sumAreaByDistrict(deyrHarvestDisrupted, districts, 'deyr_harvest_ha');

var districtSummary = districts.map(function(d) {
  var adm2 = d.get('ADM2_NAME');

  function getArea(fc) {
    var m = fc.filter(ee.Filter.eq('ADM2_NAME', adm2)).first();
    return ee.Number(ee.Algorithms.If(m, m.get('sum'), 0));
  }

  var guLandprepVal = getArea(guLandprepDistrict);
  var guSowingVal = getArea(guSowingDistrict);
  var guHarvestVal = getArea(guHarvestDistrict);

  var deyrLandprepVal = getArea(deyrLandprepDistrict);
  var deyrSowingVal = getArea(deyrSowingDistrict);
  var deyrHarvestVal = getArea(deyrHarvestDistrict);

  var guConf = guSowingConflict.filterBounds(d.geometry());
  var deyrConf = deyrSowingConflict.filterBounds(d.geometry());

  var guDtm = guSowingDTM.filterBounds(d.geometry());
  var deyrDtm = deyrSowingDTM.filterBounds(d.geometry());

  return d
    .set('gu_landprep_disrupted_ha', guLandprepVal)
    .set('gu_sowing_disrupted_ha', guSowingVal)
    .set('gu_harvest_disrupted_ha', guHarvestVal)
    .set('deyr_landprep_disrupted_ha', deyrLandprepVal)
    .set('deyr_sowing_disrupted_ha', deyrSowingVal)
    .set('deyr_harvest_disrupted_ha', deyrHarvestVal)
    .set('gu_conflict_events_sowing', guConf.size())
    .set('deyr_conflict_events_sowing', deyrConf.size())
    .set('gu_displaced_sowing', guDtm.aggregate_sum('Total new arrivals since last week'))
    .set('deyr_displaced_sowing', deyrDtm.aggregate_sum('Total new arrivals since last week'));
});


// =====================================================
// 15. MAP LAYERS
// =====================================================
Map.addLayer(cropland, {palette: ['FFFF00']}, 'Cropland prior', false);
Map.addLayer(guPeak, {min: 0.2, max: 0.8, palette: ['brown', 'yellow', 'green']}, 'GU NDVI peak', false);
Map.addLayer(deyrPeak, {min: 0.2, max: 0.8, palette: ['brown', 'yellow', 'green']}, 'DEYR NDVI peak', false);

// Key outputs
Map.addLayer(guLandprepDisrupted, {palette: ['8B0000']}, 'GU land preparation disrupted', true);
Map.addLayer(guSowingDisrupted, {palette: ['FF0000']}, 'GU sowing disrupted', true);
Map.addLayer(guHarvestDisrupted, {palette: ['FFA500']}, 'GU harvest disrupted', false);

Map.addLayer(deyrLandprepDisrupted, {palette: ['4B0082']}, 'DEYR land preparation disrupted', false);
Map.addLayer(deyrSowingDisrupted, {palette: ['800080']}, 'DEYR sowing disrupted', false);
Map.addLayer(deyrHarvestDisrupted, {palette: ['DA70D6']}, 'DEYR harvest disrupted', false);

// Events
Map.addLayer(guSowingConflict, {color: '000000'}, 'GU sowing conflict points', true);
Map.addLayer(guSowingDTM, {color: '00FFFF'}, 'GU sowing displacement origin points', true);
Map.addLayer(deyrSowingConflict, {color: '444444'}, 'DEYR sowing conflict points', false);
Map.addLayer(deyrSowingDTM, {color: '00AAFF'}, 'DEYR sowing displacement origin points', false);


// =====================================================
// 16. LEGEND
// =====================================================
function addLegend() {
  var legend = ui.Panel({
    style: {
      position: 'bottom-right',
      padding: '8px 12px',
      width: '280px'
    }
  });

  legend.add(ui.Label({
    value: 'Agricultural calendar disruption',
    style: {fontWeight: 'bold', fontSize: '14px'}
  }));

  function row(color, label) {
    var colorBox = ui.Label('', {
      backgroundColor: color,
      padding: '8px',
      margin: '0 0 4px 0'
    });
    var desc = ui.Label(label, {margin: '0 0 4px 6px'});
    return ui.Panel([colorBox, desc], ui.Panel.Layout.Flow('horizontal'));
  }

  legend.add(row('#8B0000', 'GU land preparation disrupted'));
  legend.add(row('#FF0000', 'GU sowing disrupted'));
  legend.add(row('#FFA500', 'GU harvest disrupted'));
  legend.add(row('#4B0082', 'DEYR land preparation disrupted'));
  legend.add(row('#800080', 'DEYR sowing disrupted'));
  legend.add(row('#DA70D6', 'DEYR harvest disrupted'));
  legend.add(row('#000000', 'Conflict events'));
  legend.add(row('#00FFFF', 'Displacement origin points'));

  Map.add(legend);
}
addLegend();


// =====================================================
// 17. INFO PANEL
// =====================================================
var panel = ui.Panel({
  style: {
    position: 'top-left',
    width: '390px',
    padding: '10px'
  }
});

panel.add(ui.Label({
  value: 'Somalia agricultural calendar disruption',
  style: {fontWeight: 'bold', fontSize: '16px'}
}));

panel.add(ui.Label('Purpose: show disruption of farming calendar, not yield loss'));
panel.add(ui.Label('Year: ' + SETTINGS.targetYear));
panel.add(ui.Label('Buffer: ' + (SETTINGS.riskBufferMeters / 1000) + ' km'));

var l1 = ui.Label('GU land preparation disrupted area: loading...');
var l2 = ui.Label('GU sowing disrupted area: loading...');
var l3 = ui.Label('GU harvest disrupted area: loading...');
var l4 = ui.Label('DEYR land preparation disrupted area: loading...');
var l5 = ui.Label('DEYR sowing disrupted area: loading...');
var l6 = ui.Label('DEYR harvest disrupted area: loading...');
var l7 = ui.Label('GU displaced people from active ag areas during sowing: loading...');
var l8 = ui.Label('DEYR displaced people from active ag areas during sowing: loading...');

panel.add(l1);
panel.add(l2);
panel.add(l3);
panel.add(l4);
panel.add(l5);
panel.add(l6);
panel.add(l7);
panel.add(l8);

Map.add(panel);

guLandprepHa.evaluate(function(v) { l1.setValue('GU land preparation disrupted area: ' + Math.round(v || 0) + ' ha'); });
guSowingHa.evaluate(function(v) { l2.setValue('GU sowing disrupted area: ' + Math.round(v || 0) + ' ha'); });
guHarvestHa.evaluate(function(v) { l3.setValue('GU harvest disrupted area: ' + Math.round(v || 0) + ' ha'); });

deyrLandprepHa.evaluate(function(v) { l4.setValue('DEYR land preparation disrupted area: ' + Math.round(v || 0) + ' ha'); });
deyrSowingHa.evaluate(function(v) { l5.setValue('DEYR sowing disrupted area: ' + Math.round(v || 0) + ' ha'); });
deyrHarvestHa.evaluate(function(v) { l6.setValue('DEYR harvest disrupted area: ' + Math.round(v || 0) + ' ha'); });

guDisplacedPeople.evaluate(function(v) { l7.setValue('GU displaced people from active ag areas during sowing: ' + Math.round(v || 0)); });
deyrDisplacedPeople.evaluate(function(v) { l8.setValue('DEYR displaced people from active ag areas during sowing: ' + Math.round(v || 0)); });


// =====================================================
// 18. PRINT OUTPUTS
// =====================================================
print('GU sowing conflict events', guSowingConflict.limit(10));
print('GU sowing displacement points', guSowingDTM.limit(10));
print('District summary', districtSummary.limit(50));

print('GU land preparation disrupted area (ha)', guLandprepHa);
print('GU sowing disrupted area (ha)', guSowingHa);
print('GU harvest disrupted area (ha)', guHarvestHa);

print('DEYR land preparation disrupted area (ha)', deyrLandprepHa);
print('DEYR sowing disrupted area (ha)', deyrSowingHa);
print('DEYR harvest disrupted area (ha)', deyrHarvestHa);


// =====================================================
// 19. MAP CLICK
// =====================================================
Map.onClick(function(coords) {
  var pt = ee.Geometry.Point([coords.lon, coords.lat]);
  var district = districtSummary.filterBounds(pt).first();

  district.evaluate(function(d) {
    if (!d) {
      print('No district found.');
      return;
    }
    print('Clicked district summary:', d.properties);
  });
});


// =====================================================
// 20. EXPORTS
// =====================================================
Export.image.toDrive({
  image: guLandprepDisrupted,
  description: 'Somalia_GU_Landprep_Disrupted_' + SETTINGS.targetYear,
  region: somalia,
  scale: SETTINGS.scale,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: guSowingDisrupted,
  description: 'Somalia_GU_Sowing_Disrupted_' + SETTINGS.targetYear,
  region: somalia,
  scale: SETTINGS.scale,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: guHarvestDisrupted,
  description: 'Somalia_GU_Harvest_Disrupted_' + SETTINGS.targetYear,
  region: somalia,
  scale: SETTINGS.scale,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: deyrLandprepDisrupted,
  description: 'Somalia_DEYR_Landprep_Disrupted_' + SETTINGS.targetYear,
  region: somalia,
  scale: SETTINGS.scale,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: deyrSowingDisrupted,
  description: 'Somalia_DEYR_Sowing_Disrupted_' + SETTINGS.targetYear,
  region: somalia,
  scale: SETTINGS.scale,
  maxPixels: 1e13
});

Export.image.toDrive({
  image: deyrHarvestDisrupted,
  description: 'Somalia_DEYR_Harvest_Disrupted_' + SETTINGS.targetYear,
  region: somalia,
  scale: SETTINGS.scale,
  maxPixels: 1e13
});

Export.table.toDrive({
  collection: districtSummary,
  description: 'Somalia_Agri_Calendar_Disruption_District_Summary_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});