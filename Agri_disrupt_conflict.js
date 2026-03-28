/**************************************************************
 SOMALIA AGRICULTURAL CALENDAR DISRUPTION ANALYSIS
 Conflict and displacement impacts on farming calendar
 Google Earth Engine JavaScript API

 PURPOSE
 Show how conflict and displacement affect agricultural timing
 in Somalia by identifying how many displaced people came
 from agricultural areas during key Gu and Deyr calendar stages.

 MAIN OUTPUTS
 1. Displaced people from agricultural areas by calendar stage
 2. ACLED conflict events by calendar stage
 3. District summary using Somalia district boundaries
 4. Map layers for conflict and displacement origin points

 REQUIRED USER ASSETS
 - ACLED Somalia table asset
 - IOM DTM Somalia ETT table asset

 IMPORTANT
 - Replace the asset IDs below with your own
 - Export the DTM Excel file to CSV before uploading to GEE
**************************************************************/

// =====================================================
// 1. USER SETTINGS
// =====================================================
var SETTINGS = {
  targetYear: 2025,
  scale: 10,
  conflictBufferMeters: 5000,   // for visualization only if needed

  // Replace with your actual uploaded Earth Engine assets
  // Replace with your own assets
  acledAsset: 'projects/studious-legend-447918-u1/assets/ACLED_Somalia_2024_2025',
  dtmAsset: 'projects/studious-legend-447918-u1/assets/IOM_DTM_ETT_Somalia',

  // NDVI thresholds for seasonal activity masks
  guActiveThreshold: 0.30,
  deyrActiveThreshold: 0.28,

  // Agricultural calendar windows
  gu: {
    landprepStart: '2025-02-01',
    landprepEnd:   '2025-03-31',
    sowingStart:   '2025-04-01',
    sowingEnd:     '2025-05-15',
    growingStart:  '2025-05-16',
    growingEnd:    '2025-07-31',
    harvestStart:  '2025-08-01',
    harvestEnd:    '2025-09-30'
  },

  deyr: {
    landprepStart: '2025-09-01',
    landprepEnd:   '2025-10-15',
    sowingStart:   '2025-10-16',
    sowingEnd:     '2025-11-30',
    growingStart:  '2025-12-01',
    growingEnd:    '2025-01-31',
    harvestStart:  '2025-02-01',
    harvestEnd:    '2025-03-31'
  }
};


// =====================================================
// 2. SOMALIA BOUNDARIES AND DISTRICTS
// =====================================================
// National boundary
var countries = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017');
var somalia = countries.filter(ee.Filter.eq('country_na', 'Somalia')).geometry();

// Somalia district boundaries from FAO GAUL Level 2
var districts = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM0_NAME', 'Somalia'));

// Optional region boundaries if needed later
var regions = ee.FeatureCollection('FAO/GAUL/2015/level1')
  .filter(ee.Filter.eq('ADM0_NAME', 'Somalia'));

Map.centerObject(somalia, 6);
Map.setOptions('SATELLITE');


// =====================================================
// 3. AGRICULTURAL MASK
// =====================================================
// ESA WorldCover cropland class = 40
var worldcover = ee.ImageCollection('ESA/WorldCover/v200').first();
var cropland = worldcover.select('Map').eq(40).clip(somalia).selfMask();


// =====================================================
// 4. SENTINEL-2 PREPARATION
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
// 5. SEASONAL AGRICULTURAL ACTIVITY
// =====================================================
// For land preparation and sowing we will use cropland prior.
// For growing and harvest we use active seasonal vegetation masks.

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

var guSeason = seasonalPeak('2024-03-01', '2024-07-31', SETTINGS.guActiveThreshold);
var deyrSeason = seasonalPeak('2024-10-01', '2025-01-31', SETTINGS.deyrActiveThreshold);

var guPeak = guSeason.peak;
var deyrPeak = deyrSeason.peak;

var guActive = guSeason.active;
var deyrActive = deyrSeason.active;


// =====================================================
// 6. LOAD ACLED AND ALIGN TO DISTRICTS
// =====================================================
var acledRaw = ee.FeatureCollection(SETTINGS.acledAsset)
  .filterBounds(somalia);

// Parse ACLED date and keep main conflict event types
var acled = acledRaw.map(function(f) {
  var parsedDate = ee.Date.parse('yyyy-MM-dd', ee.String(f.get('event_date')));
  return f.set('eventDateParsed', parsedDate.millis());
});

var acledConflict = acled.filter(
  ee.Filter.inList('event_type', [
    'Battles',
    'Violence against civilians',
    'Explosions/Remote violence',
    'Riots'
  ])
);

// Spatially align ACLED points to Somalia districts
var acledWithDistrict = acledConflict.map(function(f) {
  var match = districts.filterBounds(f.geometry()).first();
  return f.set({
    district_name: ee.Algorithms.If(match, match.get('ADM2_NAME'), null),
    region_name: ee.Algorithms.If(match, match.get('ADM1_NAME'), null)
  });
});


// =====================================================
// 7. LOAD DTM AND BUILD ORIGIN GEOMETRY
// =====================================================
// DTM columns from your uploaded file include:
// - Orgin latitude
// - Orgin longitude
// - current latitude
// - current longtiude
// - Date of Assessment
// - Main Cause of Displacement
// - Total new arrivals since last week

var dtmRaw = ee.FeatureCollection(SETTINGS.dtmAsset)
  .filterBounds(somalia);

// Helper to clean number strings
function parseMaybeNumber(val) {
  var s = ee.String(ee.Algorithms.If(val, val, ''));
  s = s.replace(',', '');
  s = s.replace(' ', '');
  return ee.Number.parse(s);
}

// Build origin geometry when origin coordinates exist.
// If missing, fall back to current coordinates.
var dtmPoints = dtmRaw.map(function(f) {
  var originLatStr = ee.String(ee.Algorithms.If(f.get('Orgin latitude'), f.get('Orgin latitude'), ''));
  var originLonStr = ee.String(ee.Algorithms.If(f.get('Orgin longitude'), f.get('Orgin longitude'), ''));

  var currLat = f.get('current latitude');
  var currLon = f.get('current longtiude');

  var hasOriginLat = originLatStr.length().gt(0);
  var hasOriginLon = originLonStr.length().gt(0);
  var hasOrigin = hasOriginLat.and(hasOriginLon);

  var finalLat = ee.Algorithms.If(hasOrigin, parseMaybeNumber(originLatStr), currLat);
  var finalLon = ee.Algorithms.If(hasOrigin, parseMaybeNumber(originLonStr), currLon);

  var geom = ee.Geometry.Point([ee.Number(finalLon), ee.Number(finalLat)]);

  var rawDate = ee.String(ee.Algorithms.If(f.get('Date of Assessment'), f.get('Date of Assessment'), ''));
  var parsedDate = ee.Date.parse('M/d/yyyy', rawDate);

  return ee.Feature(geom, f.toDictionary())
    .set('dtmDateParsed', parsedDate.millis())
    .set('used_origin_geometry', hasOrigin)
    .set('origin_or_current_lat', finalLat)
    .set('origin_or_current_lon', finalLon);
});

// Keep only records with positive arrivals
var dtmValid = dtmPoints.filter(
  ee.Filter.gt('Total new arrivals since last week', 0)
);

// Optional: strict conflict-caused displacement only
var dtmConflict = dtmValid.filter(
  ee.Filter.eq('Main Cause of Displacement', 'Conflict')
);

// Spatially align DTM points to districts
var dtmWithDistrict = dtmConflict.map(function(f) {
  var match = districts.filterBounds(f.geometry()).first();
  return f.set({
    district_name: ee.Algorithms.If(match, match.get('ADM2_NAME'), null),
    region_name: ee.Algorithms.If(match, match.get('ADM1_NAME'), null)
  });
});


// =====================================================
// 8. TIME FILTER FUNCTIONS
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


// =====================================================
// 9. CALENDAR-SPECIFIC ACLED AND DTM SETS
// =====================================================
// GU
var guLandprepConflict = filterAcledByWindow(acledWithDistrict, SETTINGS.gu.landprepStart, SETTINGS.gu.landprepEnd);
var guSowingConflict   = filterAcledByWindow(acledWithDistrict, SETTINGS.gu.sowingStart, SETTINGS.gu.sowingEnd);
var guGrowingConflict  = filterAcledByWindow(acledWithDistrict, SETTINGS.gu.growingStart, SETTINGS.gu.growingEnd);
var guHarvestConflict  = filterAcledByWindow(acledWithDistrict, SETTINGS.gu.harvestStart, SETTINGS.gu.harvestEnd);

var guLandprepDTM = filterDTMByWindow(dtmWithDistrict, SETTINGS.gu.landprepStart, SETTINGS.gu.landprepEnd);
var guSowingDTM   = filterDTMByWindow(dtmWithDistrict, SETTINGS.gu.sowingStart, SETTINGS.gu.sowingEnd);
var guGrowingDTM  = filterDTMByWindow(dtmWithDistrict, SETTINGS.gu.growingStart, SETTINGS.gu.growingEnd);
var guHarvestDTM  = filterDTMByWindow(dtmWithDistrict, SETTINGS.gu.harvestStart, SETTINGS.gu.harvestEnd);

// DEYR
var deyrLandprepConflict = filterAcledByWindow(acledWithDistrict, SETTINGS.deyr.landprepStart, SETTINGS.deyr.landprepEnd);
var deyrSowingConflict   = filterAcledByWindow(acledWithDistrict, SETTINGS.deyr.sowingStart, SETTINGS.deyr.sowingEnd);
var deyrGrowingConflict  = filterAcledByWindow(acledWithDistrict, SETTINGS.deyr.growingStart, SETTINGS.deyr.growingEnd);
var deyrHarvestConflict  = filterAcledByWindow(acledWithDistrict, SETTINGS.deyr.harvestStart, SETTINGS.deyr.harvestEnd);

var deyrLandprepDTM = filterDTMByWindow(dtmWithDistrict, SETTINGS.deyr.landprepStart, SETTINGS.deyr.landprepEnd);
var deyrSowingDTM   = filterDTMByWindow(dtmWithDistrict, SETTINGS.deyr.sowingStart, SETTINGS.deyr.sowingEnd);
var deyrGrowingDTM  = filterDTMByWindow(dtmWithDistrict, SETTINGS.deyr.growingStart, SETTINGS.deyr.growingEnd);
var deyrHarvestDTM  = filterDTMByWindow(dtmWithDistrict, SETTINGS.deyr.harvestStart, SETTINGS.deyr.harvestEnd);


// =====================================================
// 10. TAG DTM ORIGIN POINTS INSIDE AGRICULTURAL AREAS
// =====================================================
// For land prep and sowing use cropland prior.
// For growing and harvest use seasonal active mask.

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

// GU
var guLandprepDTMInAg = tagPointInCrop(guLandprepDTM, cropland, 'in_ag')
  .filter(ee.Filter.eq('in_ag', 1));

var guSowingDTMInAg = tagPointInCrop(guSowingDTM, cropland, 'in_ag')
  .filter(ee.Filter.eq('in_ag', 1));

var guGrowingDTMInAg = tagPointInCrop(guGrowingDTM, guActive, 'in_ag')
  .filter(ee.Filter.eq('in_ag', 1));

var guHarvestDTMInAg = tagPointInCrop(guHarvestDTM, guActive, 'in_ag')
  .filter(ee.Filter.eq('in_ag', 1));

// DEYR
var deyrLandprepDTMInAg = tagPointInCrop(deyrLandprepDTM, cropland, 'in_ag')
  .filter(ee.Filter.eq('in_ag', 1));

var deyrSowingDTMInAg = tagPointInCrop(deyrSowingDTM, cropland, 'in_ag')
  .filter(ee.Filter.eq('in_ag', 1));

var deyrGrowingDTMInAg = tagPointInCrop(deyrGrowingDTM, deyrActive, 'in_ag')
  .filter(ee.Filter.eq('in_ag', 1));

var deyrHarvestDTMInAg = tagPointInCrop(deyrHarvestDTM, deyrActive, 'in_ag')
  .filter(ee.Filter.eq('in_ag', 1));


// =====================================================
// 11. NATIONAL COUNTS OF DISPLACED PEOPLE FROM AG AREAS
// =====================================================
var guLandprepDisplaced = ee.Number(
  guLandprepDTMInAg.aggregate_sum('Total new arrivals since last week')
);

var guSowingDisplaced = ee.Number(
  guSowingDTMInAg.aggregate_sum('Total new arrivals since last week')
);

var guGrowingDisplaced = ee.Number(
  guGrowingDTMInAg.aggregate_sum('Total new arrivals since last week')
);

var guHarvestDisplaced = ee.Number(
  guHarvestDTMInAg.aggregate_sum('Total new arrivals since last week')
);

var deyrLandprepDisplaced = ee.Number(
  deyrLandprepDTMInAg.aggregate_sum('Total new arrivals since last week')
);

var deyrSowingDisplaced = ee.Number(
  deyrSowingDTMInAg.aggregate_sum('Total new arrivals since last week')
);

var deyrGrowingDisplaced = ee.Number(
  deyrGrowingDTMInAg.aggregate_sum('Total new arrivals since last week')
);

var deyrHarvestDisplaced = ee.Number(
  deyrHarvestDTMInAg.aggregate_sum('Total new arrivals since last week')
);


// =====================================================
// 12. NATIONAL CONFLICT COUNTS DURING CALENDAR STAGES
// =====================================================
var guLandprepConflictCount = guLandprepConflict.size();
var guSowingConflictCount   = guSowingConflict.size();
var guGrowingConflictCount  = guGrowingConflict.size();
var guHarvestConflictCount  = guHarvestConflict.size();

var deyrLandprepConflictCount = deyrLandprepConflict.size();
var deyrSowingConflictCount   = deyrSowingConflict.size();
var deyrGrowingConflictCount  = deyrGrowingConflict.size();
var deyrHarvestConflictCount  = deyrHarvestConflict.size();


// =====================================================
// 13. DISTRICT SUMMARY
// =====================================================
var districtSummary = districts.map(function(d) {
  var districtName = d.get('ADM2_NAME');
  var regionName = d.get('ADM1_NAME');

  // DTM from agricultural areas by stage
  var guLandprepPts = guLandprepDTMInAg.filterBounds(d.geometry());
  var guSowingPts   = guSowingDTMInAg.filterBounds(d.geometry());
  var guGrowingPts  = guGrowingDTMInAg.filterBounds(d.geometry());
  var guHarvestPts  = guHarvestDTMInAg.filterBounds(d.geometry());

  var deyrLandprepPts = deyrLandprepDTMInAg.filterBounds(d.geometry());
  var deyrSowingPts   = deyrSowingDTMInAg.filterBounds(d.geometry());
  var deyrGrowingPts  = deyrGrowingDTMInAg.filterBounds(d.geometry());
  var deyrHarvestPts  = deyrHarvestDTMInAg.filterBounds(d.geometry());

  // Conflict by stage
  var guLandprepConf = guLandprepConflict.filterBounds(d.geometry());
  var guSowingConf   = guSowingConflict.filterBounds(d.geometry());
  var guGrowingConf  = guGrowingConflict.filterBounds(d.geometry());
  var guHarvestConf  = guHarvestConflict.filterBounds(d.geometry());

  var deyrLandprepConf = deyrLandprepConflict.filterBounds(d.geometry());
  var deyrSowingConf   = deyrSowingConflict.filterBounds(d.geometry());
  var deyrGrowingConf  = deyrGrowingConflict.filterBounds(d.geometry());
  var deyrHarvestConf  = deyrHarvestConflict.filterBounds(d.geometry());

  return d.set({
    region_name: regionName,
    district_name: districtName,

    gu_landprep_displaced: guLandprepPts.aggregate_sum('Total new arrivals since last week'),
    gu_sowing_displaced: guSowingPts.aggregate_sum('Total new arrivals since last week'),
    gu_growing_displaced: guGrowingPts.aggregate_sum('Total new arrivals since last week'),
    gu_harvest_displaced: guHarvestPts.aggregate_sum('Total new arrivals since last week'),

    deyr_landprep_displaced: deyrLandprepPts.aggregate_sum('Total new arrivals since last week'),
    deyr_sowing_displaced: deyrSowingPts.aggregate_sum('Total new arrivals since last week'),
    deyr_growing_displaced: deyrGrowingPts.aggregate_sum('Total new arrivals since last week'),
    deyr_harvest_displaced: deyrHarvestPts.aggregate_sum('Total new arrivals since last week'),

    gu_landprep_conflict_events: guLandprepConf.size(),
    gu_sowing_conflict_events: guSowingConf.size(),
    gu_growing_conflict_events: guGrowingConf.size(),
    gu_harvest_conflict_events: guHarvestConf.size(),

    deyr_landprep_conflict_events: deyrLandprepConf.size(),
    deyr_sowing_conflict_events: deyrSowingConf.size(),
    deyr_growing_conflict_events: deyrGrowingConf.size(),
    deyr_harvest_conflict_events: deyrHarvestConf.size()
  });
});


// =====================================================
// 14. DEBUGGING OUTPUTS
// =====================================================
print('Somalia districts', districts.limit(10));
print('Cropland pixels count', cropland.reduceRegion({
  reducer: ee.Reducer.count(),
  geometry: somalia,
  scale: 30,
  maxPixels: 1e12
}));

print('GU active pixels count', guActive.reduceRegion({
  reducer: ee.Reducer.count(),
  geometry: somalia,
  scale: 30,
  maxPixels: 1e12
}));

print('DEYR active pixels count', deyrActive.reduceRegion({
  reducer: ee.Reducer.count(),
  geometry: somalia,
  scale: 30,
  maxPixels: 1e12
}));

print('GU landprep DTM count', guLandprepDTM.size());
print('GU sowing DTM count', guSowingDTM.size());
print('DEYR landprep DTM count', deyrLandprepDTM.size());
print('DEYR sowing DTM count', deyrSowingDTM.size());

print('GU landprep DTM in agriculture', guLandprepDTMInAg.size());
print('GU sowing DTM in agriculture', guSowingDTMInAg.size());
print('DEYR landprep DTM in agriculture', deyrLandprepDTMInAg.size());
print('DEYR sowing DTM in agriculture', deyrSowingDTMInAg.size());


// =====================================================
// 15. MAP LAYERS
// =====================================================
Map.addLayer(cropland, {palette: ['FFFF00']}, 'Cropland prior', false);
Map.addLayer(guPeak, {min: 0.2, max: 0.8, palette: ['brown', 'yellow', 'green']}, 'GU NDVI peak', false);
Map.addLayer(deyrPeak, {min: 0.2, max: 0.8, palette: ['brown', 'yellow', 'green']}, 'DEYR NDVI peak', false);

Map.addLayer(districts.style({
  color: 'white',
  fillColor: '00000000',
  width: 1
}), {}, 'Somalia district boundaries', true);

// DTM agricultural-origin points by stage
Map.addLayer(guLandprepDTMInAg, {color: '8B0000'}, 'GU landprep displaced from ag', false);
Map.addLayer(guSowingDTMInAg, {color: 'FF0000'}, 'GU sowing displaced from ag', true);
Map.addLayer(guGrowingDTMInAg, {color: 'FF8C00'}, 'GU growing displaced from ag', false);
Map.addLayer(guHarvestDTMInAg, {color: 'FFD700'}, 'GU harvest displaced from ag', false);

Map.addLayer(deyrLandprepDTMInAg, {color: '4B0082'}, 'DEYR landprep displaced from ag', false);
Map.addLayer(deyrSowingDTMInAg, {color: '800080'}, 'DEYR sowing displaced from ag', false);
Map.addLayer(deyrGrowingDTMInAg, {color: 'BA55D3'}, 'DEYR growing displaced from ag', false);
Map.addLayer(deyrHarvestDTMInAg, {color: 'DA70D6'}, 'DEYR harvest displaced from ag', false);

// ACLED conflict points by stage
Map.addLayer(guSowingConflict, {color: '000000'}, 'GU sowing conflict', true);
Map.addLayer(deyrSowingConflict, {color: '444444'}, 'DEYR sowing conflict', false);


// =====================================================
// 16. LEGEND
// =====================================================
function addLegend() {
  var legend = ui.Panel({
    style: {
      position: 'bottom-right',
      padding: '8px 12px',
      width: '300px'
    }
  });

  legend.add(ui.Label({
    value: 'Somalia agriculture and displacement',
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

  legend.add(row('#FFFFFF', 'District boundaries'));
  legend.add(row('#FF0000', 'GU sowing displaced from ag'));
  legend.add(row('#8B0000', 'GU landprep displaced from ag'));
  legend.add(row('#FF8C00', 'GU growing displaced from ag'));
  legend.add(row('#FFD700', 'GU harvest displaced from ag'));
  legend.add(row('#800080', 'DEYR sowing displaced from ag'));
  legend.add(row('#4B0082', 'DEYR landprep displaced from ag'));
  legend.add(row('#BA55D3', 'DEYR growing displaced from ag'));
  legend.add(row('#DA70D6', 'DEYR harvest displaced from ag'));
  legend.add(row('#000000', 'Conflict events'));

  Map.add(legend);
}
addLegend();


// =====================================================
// 17. INFO PANEL
// =====================================================
var panel = ui.Panel({
  style: {
    position: 'top-left',
    width: '420px',
    padding: '10px'
  }
});

panel.add(ui.Label({
  value: 'Somalia agricultural displacement from farming areas',
  style: {fontWeight: 'bold', fontSize: '16px'}
}));

panel.add(ui.Label('Purpose: count displaced people from agricultural areas during key Gu and Deyr stages'));
panel.add(ui.Label('Year: ' + SETTINGS.targetYear));
panel.add(ui.Label('District boundary source: FAO GAUL level 2'));

var l1 = ui.Label('GU land preparation displaced from ag areas: loading...');
var l2 = ui.Label('GU sowing displaced from ag areas: loading...');
var l3 = ui.Label('GU growing displaced from ag areas: loading...');
var l4 = ui.Label('GU harvest displaced from ag areas: loading...');

var l5 = ui.Label('DEYR land preparation displaced from ag areas: loading...');
var l6 = ui.Label('DEYR sowing displaced from ag areas: loading...');
var l7 = ui.Label('DEYR growing displaced from ag areas: loading...');
var l8 = ui.Label('DEYR harvest displaced from ag areas: loading...');

var c1 = ui.Label('GU land preparation conflict events: loading...');
var c2 = ui.Label('GU sowing conflict events: loading...');
var c3 = ui.Label('DEYR land preparation conflict events: loading...');
var c4 = ui.Label('DEYR sowing conflict events: loading...');

panel.add(l1);
panel.add(l2);
panel.add(l3);
panel.add(l4);
panel.add(l5);
panel.add(l6);
panel.add(l7);
panel.add(l8);
panel.add(c1);
panel.add(c2);
panel.add(c3);
panel.add(c4);

Map.add(panel);

guLandprepDisplaced.evaluate(function(v) {
  l1.setValue('GU land preparation displaced from ag areas: ' + Math.round(v || 0));
});
guSowingDisplaced.evaluate(function(v) {
  l2.setValue('GU sowing displaced from ag areas: ' + Math.round(v || 0));
});
guGrowingDisplaced.evaluate(function(v) {
  l3.setValue('GU growing displaced from ag areas: ' + Math.round(v || 0));
});
guHarvestDisplaced.evaluate(function(v) {
  l4.setValue('GU harvest displaced from ag areas: ' + Math.round(v || 0));
});

deyrLandprepDisplaced.evaluate(function(v) {
  l5.setValue('DEYR land preparation displaced from ag areas: ' + Math.round(v || 0));
});
deyrSowingDisplaced.evaluate(function(v) {
  l6.setValue('DEYR sowing displaced from ag areas: ' + Math.round(v || 0));
});
deyrGrowingDisplaced.evaluate(function(v) {
  l7.setValue('DEYR growing displaced from ag areas: ' + Math.round(v || 0));
});
deyrHarvestDisplaced.evaluate(function(v) {
  l8.setValue('DEYR harvest displaced from ag areas: ' + Math.round(v || 0));
});

guLandprepConflictCount.evaluate(function(v) {
  c1.setValue('GU land preparation conflict events: ' + Math.round(v || 0));
});
guSowingConflictCount.evaluate(function(v) {
  c2.setValue('GU sowing conflict events: ' + Math.round(v || 0));
});
deyrLandprepConflictCount.evaluate(function(v) {
  c3.setValue('DEYR land preparation conflict events: ' + Math.round(v || 0));
});
deyrSowingConflictCount.evaluate(function(v) {
  c4.setValue('DEYR sowing conflict events: ' + Math.round(v || 0));
});


// =====================================================
// 18. PRINT OUTPUTS
// =====================================================
print('District summary', districtSummary.limit(50));

print('GU land preparation displaced from agricultural areas', guLandprepDisplaced);
print('GU sowing displaced from agricultural areas', guSowingDisplaced);
print('GU growing displaced from agricultural areas', guGrowingDisplaced);
print('GU harvest displaced from agricultural areas', guHarvestDisplaced);

print('DEYR land preparation displaced from agricultural areas', deyrLandprepDisplaced);
print('DEYR sowing displaced from agricultural areas', deyrSowingDisplaced);
print('DEYR growing displaced from agricultural areas', deyrGrowingDisplaced);
print('DEYR harvest displaced from agricultural areas', deyrHarvestDisplaced);

print('GU land preparation conflict events', guLandprepConflictCount);
print('GU sowing conflict events', guSowingConflictCount);
print('DEYR land preparation conflict events', deyrLandprepConflictCount);
print('DEYR sowing conflict events', deyrSowingConflictCount);


// =====================================================
// 19. MAP CLICK: DISTRICT INSPECTION
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
Export.table.toDrive({
  collection: districtSummary,
  description: 'Somalia_District_Ag_Displacement_Conflict_Summary_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});

Export.table.toDrive({
  collection: guLandprepDTMInAg,
  description: 'Somalia_GU_Landprep_Displaced_From_Ag_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});

Export.table.toDrive({
  collection: guSowingDTMInAg,
  description: 'Somalia_GU_Sowing_Displaced_From_Ag_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});

Export.table.toDrive({
  collection: guGrowingDTMInAg,
  description: 'Somalia_GU_Growing_Displaced_From_Ag_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});

Export.table.toDrive({
  collection: guHarvestDTMInAg,
  description: 'Somalia_GU_Harvest_Displaced_From_Ag_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});

Export.table.toDrive({
  collection: deyrLandprepDTMInAg,
  description: 'Somalia_DEYR_Landprep_Displaced_From_Ag_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});

Export.table.toDrive({
  collection: deyrSowingDTMInAg,
  description: 'Somalia_DEYR_Sowing_Displaced_From_Ag_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});

Export.table.toDrive({
  collection: deyrGrowingDTMInAg,
  description: 'Somalia_DEYR_Growing_Displaced_From_Ag_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});

Export.table.toDrive({
  collection: deyrHarvestDTMInAg,
  description: 'Somalia_DEYR_Harvest_Displaced_From_Ag_' + SETTINGS.targetYear,
  fileFormat: 'CSV'
});