const TIME_FIELDS = ["weekday_AM","weekday_MD","weekday_PM","weekend_AM","weekend_MD","weekend_PM"];
const DATA_VERSION = "15";
const SCORE_INDEX = {weekday_AM:3,weekday_MD:4,weekday_PM:5,weekend_AM:6,weekend_MD:7,weekend_PM:8};
const COLORS = {zero:"#d81b60",low:"#ff7a00",served:"#6d28d9"};
let activeEligibilityScenario={id:"baseline",family:"Baseline",label:"All recorded facilities",definition:"All public and semi-public restroom candidates in the study inventory"};
let activeMapUnit="tract";

const map = L.map("map", {zoomControl:false, preferCanvas:true, minZoom:9, maxZoom:19}).setView([40.7128,-74.006], 11);
map.createPane("surfacePane");
map.getPane("surfacePane").style.zIndex=250;
map.getPane("surfacePane").style.pointerEvents="none";
map.createPane("roadPane");
map.getPane("roadPane").style.zIndex=650;
map.getPane("roadPane").style.pointerEvents="none";
map.createPane("selectedRoadPane");
map.getPane("selectedRoadPane").style.zIndex=850;
map.getPane("selectedRoadPane").style.pointerEvents="none";
L.control.zoom({position:"bottomright"}).addTo(map);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
  maxNativeZoom:16,
  maxZoom:19,
  attribution:'Tiles © <a href="https://www.esri.com/">Esri</a>'
}).addTo(map);

let meta, tractsData, tractLayer, roadsLayer = L.layerGroup({pane:"roadPane"}).addTo(map);
let selectedRoadLayer, currentPoint, currentLabel = "Selected point";
let compareMap, compareLeftLayer, compareRightLayer, compareControl;
let analysisToken=0;
let roadRenderToken=0;
const tileCache = new Map();
const availableTiles = new Set();
const resultPanel = document.querySelector("#result-panel");

const coreData=window.BATHROOM_DATA?.meta&&window.BATHROOM_DATA?.tracts
  ? Promise.resolve([window.BATHROOM_DATA.meta,window.BATHROOM_DATA.tracts])
  : Promise.all([
      fetch(`data/meta.json?v=${DATA_VERSION}`).then(r=>r.json()),
      fetch(`data/tracts.geojson?v=${DATA_VERSION}`).then(r=>r.json())
    ]);

coreData.then(([m,t])=>{
  meta=m; tractsData=t;
  m.tiles.forEach(([x,y])=>availableTiles.add(`${x}_${y}`));
  updateEligibilityScenario();
  tractLayer=L.geoJSON(t,{
    pane:"surfacePane",
    interactive:false,
    smoothFactor:0,
    style:feature=>({
      pane:"surfacePane",
      stroke:false,
      fill:true,
      fillColor:accessibilityColor(feature.properties),
      fillOpacity:.82
    })
  }).addTo(map);
  initComparisonMap();
  if(activeMapUnit==="road"){
    map.removeLayer(tractLayer);
    renderVisibleRoads();
  }
}).catch(()=>showMapError("The research layers could not be loaded."));

function accessibilityColor(properties){
  return accessibilityColorForScore(properties,tractScenarioScore(properties));
}

function accessibilityColorForScore(properties,score){
  if(properties.veryLowActivity)return "#a6abb2";
  if(!properties.flow)return "#3f4652";
  const value=Math.max(0,Math.min(9.81,score*100000));
  const stops=[[0,[22,28,45]],[.34,[34,96,126]],[.68,[33,178,151]],[1,[255,209,102]]];
  const t=value/9.81;
  for(let i=0;i<stops.length-1;i++){
    const [lo,a]=stops[i],[hi,b]=stops[i+1];
    if(t<=hi){
      const mix=(t-lo)/(hi-lo);
      const rgb=a.map((channel,j)=>Math.round(channel+(b[j]-channel)*mix));
      return `rgb(${rgb.join(",")})`;
    }
  }
  return "rgb(255,209,102)";
}

document.querySelector("#search-form").addEventListener("submit", async e=>{
  e.preventDefault();
  const q=document.querySelector("#address").value.trim();
  if(!q)return;
  setSearchBusy(true);
  try{
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&viewbox=-74.30,40.92,-73.68,40.47&bounded=1&q=${encodeURIComponent(q+", New York City")}`;
    const data=await fetch(url,{headers:{"Accept":"application/json"}}).then(r=>r.json());
    if(!data.length)throw new Error("No NYC match found");
    currentLabel=data[0].display_name.split(",").slice(0,2).join(",");
    await analyzePoint(Number(data[0].lat),Number(data[0].lon),true);
  }catch(err){
    showMapError(err.message||"We couldn't find that location.");
  }finally{setSearchBusy(false)}
});

document.querySelector("#locate-me").addEventListener("click",()=>{
  if(!navigator.geolocation)return showMapError("Location is not available in this browser.");
  navigator.geolocation.getCurrentPosition(pos=>{
    const {latitude,longitude}=pos.coords;
    if(latitude<40.45||latitude>40.95||longitude<-74.35||longitude>-73.65)return showMapError("Your location appears to be outside New York City.");
    currentLabel="Your location"; analyzePoint(latitude,longitude,true);
  },()=>showMapError("Location permission was not granted."),{enableHighAccuracy:true,timeout:9000});
});

document.querySelector("#time-window").addEventListener("change",()=>{
  refreshTractLayer();
  updateLegend();
  refreshCurrentResult();
});
document.querySelector("#eligibility-scenario").addEventListener("change",()=>{
  updateEligibilityScenario();
  refreshCurrentResult();
});
document.querySelectorAll("[data-map-unit]").forEach(button=>button.addEventListener("click",()=>setMapUnit(button.dataset.mapUnit)));
document.querySelector("#close-result").addEventListener("click",()=>{resultPanel.classList.remove("open");resultPanel.setAttribute("aria-hidden","true")});
map.on("click",e=>{currentLabel="Map selection";analyzePoint(e.latlng.lat,e.latlng.lng,false)});
map.on("moveend",()=>{if(activeMapUnit==="road")renderVisibleRoads()});

async function analyzePoint(lat,lon,focus){
  if(!meta)return showMapError("The research layers are still loading. Try again in a moment.");
  const token=++analysisToken;
  currentPoint={lat,lon};
  if(focus)map.setView([lat,lon],Math.max(map.getZoom(),15),{animate:false});
  openResultsLoading();
  const roads=await loadRoadNeighborhood(lat,lon);
  if(token!==analysisToken)return;
  const nearest=nearestRoad(lat,lon,roads);
  if(!nearest){showMapError("No modeled road was found near this point.");return}
  const time=document.querySelector("#time-window").value;
  const score=Number(nearest[SCORE_INDEX[time]])||0;
  const threshold=meta.thresholds[`score_${time}`];
  const status=score<=0?"zero":score<=threshold?"low":"served";
  const tract=findTract(lon,lat);
  drawSelection(nearest,status);
  if(activeMapUnit==="road")renderVisibleRoads();
  else drawNearbyRoads(lat,lon,roads);
  renderResults({status,score,threshold,tract,distance:nearest._distance,time});
}

async function loadRoadNeighborhood(lat,lon){
  const tx=Math.floor(lon/meta.tileSize),ty=Math.floor(lat/meta.tileSize);
  const keys=[];
  for(let x=tx-1;x<=tx+1;x++)for(let y=ty-1;y<=ty+1;y++)if(availableTiles.has(`${x}_${y}`))keys.push(`${x}_${y}`);
  const batches=await Promise.all(keys.map(async key=>{
    return loadRoadTile(key);
  }));
  return batches.flat();
}

async function loadRoadTile(key){
  if(tileCache.has(key))return tileCache.get(key);
  if(window.BATHROOM_ROADS?.[key]){
    const data=window.BATHROOM_ROADS[key];tileCache.set(key,data);return data;
  }
  await new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    script.src=`data/roads/${key}.js?v=${DATA_VERSION}`;
    script.onload=resolve;
    script.onerror=()=>reject(new Error(`Unable to load road tile ${key}`));
    document.head.appendChild(script);
  });
  const data=window.BATHROOM_ROADS?.[key]||[];
  tileCache.set(key,data);
  return data;
}

function nearestRoad(lat,lon,roads){
  let best=null,bestD=Infinity;
  for(const road of roads){
    const coords=road[9];
    for(let i=1;i<coords.length;i++){
      const d=pointSegmentDistance(lon,lat,coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
      if(d<bestD){bestD=d;best=road}
    }
  }
  if(best)best._distance=bestD;
  return best;
}

function pointSegmentDistance(px,py,x1,y1,x2,y2){
  const scale=Math.cos(py*Math.PI/180),dx=(x2-x1)*scale,dy=y2-y1;
  const denom=dx*dx+dy*dy;
  const t=denom?Math.max(0,Math.min(1,(((px-x1)*scale)*dx+(py-y1)*dy)/denom)):0;
  return Math.hypot(((px-x1)*scale)-t*dx,(py-y1)-t*dy)*111320;
}

function drawSelection(road,status){
  if(selectedRoadLayer)map.removeLayer(selectedRoadLayer);
  selectedRoadLayer=L.layerGroup({pane:"selectedRoadPane"}).addTo(map);
  L.polyline(road[9].map(c=>[c[1],c[0]]),{pane:"selectedRoadPane",color:"#fff",weight:12,opacity:.95,lineCap:"round"}).addTo(selectedRoadLayer);
  L.polyline(road[9].map(c=>[c[1],c[0]]),{pane:"selectedRoadPane",color:COLORS[status],weight:7,opacity:1,lineCap:"round"}).addTo(selectedRoadLayer);
  keepRoadsOnTop();
}

function drawNearbyRoads(lat,lon,roads){
  roadsLayer.clearLayers();
  (roads||[]).filter(r=>pointToRoadFast(lat,lon,r)<1500).forEach(r=>{
    const time=document.querySelector("#time-window").value,score=Number(r[SCORE_INDEX[time]])||0,threshold=meta.thresholds[`score_${time}`];
    const status=score<=0?"zero":score<=threshold?"low":"served";
    L.polyline(r[9].map(c=>[c[1],c[0]]),{pane:"roadPane",color:COLORS[status],weight:2.7,opacity:.86,interactive:false}).addTo(roadsLayer);
  });
  keepRoadsOnTop();
}

async function renderVisibleRoads(){
  const token=++roadRenderToken;
  roadsLayer.clearLayers();
  const zoomNote=document.querySelector("#road-zoom-note");
  const loadingNote=document.querySelector("#road-loading");
  if(activeMapUnit!=="road"||!meta)return;
  if(map.getZoom()<12){zoomNote.hidden=false;loadingNote.hidden=true;return}
  zoomNote.hidden=true;
  const bounds=map.getBounds();
  const minX=Math.floor(bounds.getWest()/meta.tileSize),maxX=Math.floor(bounds.getEast()/meta.tileSize);
  const minY=Math.floor(bounds.getSouth()/meta.tileSize),maxY=Math.floor(bounds.getNorth()/meta.tileSize);
  const keys=[];
  for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++)if(availableTiles.has(`${x}_${y}`))keys.push(`${x}_${y}`);
  const cachedRecords=keys.filter(key=>tileCache.has(key)).flatMap(key=>tileCache.get(key));
  if(cachedRecords.length)drawRoadRecords(cachedRecords);
  const missingKeys=keys.filter(key=>!tileCache.has(key));
  loadingNote.hidden=missingKeys.length===0;
  await Promise.all(missingKeys.map(async key=>{
    await loadRoadTile(key);
  }));
  if(token!==roadRenderToken||activeMapUnit!=="road")return;
  loadingNote.hidden=true;
  roadsLayer.clearLayers();
  drawRoadRecords(keys.flatMap(key=>tileCache.get(key)||[]));
}

function drawRoadRecords(records){
  const time=document.querySelector("#time-window").value,threshold=meta.thresholds[`score_${time}`];
  const roadWeight=map.getZoom()>=15?3:map.getZoom()>=13?2:1.35;
  records.forEach(road=>{
    const score=Number(road[SCORE_INDEX[time]])||0;
    const status=score<=0?"zero":score<=threshold?"low":"served";
    L.polyline(road[9].map(c=>[c[1],c[0]]),{pane:"roadPane",color:COLORS[status],weight:roadWeight,opacity:.82,interactive:false}).addTo(roadsLayer);
  });
  keepRoadsOnTop();
}

function setMapUnit(unit){
  if(unit===activeMapUnit)return;
  activeMapUnit=unit;
  document.querySelectorAll("[data-map-unit]").forEach(button=>{
    const active=button.dataset.mapUnit===unit;
    button.classList.toggle("active",active);
    button.setAttribute("aria-pressed",String(active));
  });
  document.querySelector("#tract-legend").hidden=unit!=="tract";
  document.querySelector("#road-legend").hidden=unit!=="road";
  if(unit==="tract"){
    ++roadRenderToken;
    roadsLayer.clearLayers();
    if(tractLayer&&!map.hasLayer(tractLayer))tractLayer.addTo(map);
    if(currentPoint){
      loadRoadNeighborhood(currentPoint.lat,currentPoint.lon).then(roads=>{
        if(activeMapUnit==="tract")drawNearbyRoads(currentPoint.lat,currentPoint.lon,roads);
      });
    }
  }else{
    if(tractLayer&&map.hasLayer(tractLayer))map.removeLayer(tractLayer);
    if(map.getZoom()<12)map.setZoom(12);
    else renderVisibleRoads();
  }
  keepRoadsOnTop();
}

function keepRoadsOnTop(){
  map.getPane("roadPane").style.zIndex=650;
  map.getPane("selectedRoadPane").style.zIndex=850;
  if(selectedRoadLayer)selectedRoadLayer.eachLayer(layer=>layer.bringToFront&&layer.bringToFront());
}

function pointToRoadFast(lat,lon,road){
  const c=road[9][Math.floor(road[9].length/2)];return haversine(lat,lon,c[1],c[0]);
}

function renderResults({status,score,tract,time}){
  const classes={zero:"Zero-access road",low:"Low-access road",served:"Served road"};
  const percentile=roadPercentile(score,time);
  const meanings={
    zero:"For this time window, the nearest road has no modeled restroom opportunity within the study catchment.",
    low:"The nearest road has some modeled access, but it falls within the lowest 20% of positive road accessibility scores.",
    served:"The nearest road is above the study’s bathroom-desert threshold for this time window."
  };
  document.querySelector("#result-location").textContent=currentLabel;
  document.querySelector("#road-status").innerHTML=status==="served"
    ? 'You are not in a <span class="term" tabindex="0" data-tooltip="A road is a restroom desert when it has zero modeled access or falls in the lowest 20% of positive accessibility scores for this time window.">restroom desert</span>'
    : 'You are in a <span class="term" tabindex="0" data-tooltip="A road is a restroom desert when it has zero modeled access or falls in the lowest 20% of positive accessibility scores for this time window.">restroom desert</span>';
  document.querySelector("#road-context").textContent=`Nearest modeled road · ${classes[status]}`;
  document.querySelector("#status-icon").className=`status-icon ${status}`;
  document.querySelector("#access-score").textContent=(score*100000).toFixed(2);
  document.querySelector("#road-percentile").textContent=ordinal(percentile);
  document.querySelector("#road-interpretation").textContent=meanings[status];
  renderScenarioResult(tract);
  resultPanel.classList.add("open");resultPanel.setAttribute("aria-hidden","false");
}

function updateEligibilityScenario(){
  const selected=document.querySelector("#eligibility-scenario").value;
  activeEligibilityScenario=(meta?.eligibilityScenarios||[]).find(item=>item.id===selected)||activeEligibilityScenario;
  const help=document.querySelector("#eligibility-help");
  help.dataset.tooltip=activeEligibilityScenario.definition;
  refreshTractLayer();
  updateLegend();
}

function refreshCurrentResult(){
  if(currentPoint)analyzePoint(currentPoint.lat,currentPoint.lon,false);
  else if(activeMapUnit==="road")renderVisibleRoads();
}

function refreshTractLayer(){
  if(!tractLayer)return;
  tractLayer.setStyle(feature=>({
    pane:"surfacePane",stroke:false,fill:true,
    fillColor:accessibilityColor(feature.properties),fillOpacity:.82
  }));
  keepRoadsOnTop();
}

function updateLegend(){
  const title=document.querySelector("#legend-title");
  if(!title)return;
  const day=document.querySelector("#time-window").value.startsWith("weekend")?"Weekend":"Weekday";
  title.textContent=`${day} ${activeEligibilityScenario.id==="baseline"?"baseline":activeEligibilityScenario.id} tract access · ×10⁵`;
  title.dataset.tooltip=`${activeEligibilityScenario.definition}. The ${day.toLowerCase()} tract-level E2SFCA score is multiplied by 100,000 for readability.`;
}

function initComparisonMap(){
  const mapElement=document.querySelector("#compare-map");
  if(compareMap||!mapElement||!tractsData||!meta)return;
  const timeSelect=document.querySelector("#compare-time");
  const leftSelect=document.querySelector("#compare-left-scenario");
  const rightSelect=document.querySelector("#compare-right-scenario");
  const times=[
    ["weekday_AM","Weekday · 8–9 AM"],["weekday_MD","Weekday · 12:30–1:30 PM"],["weekday_PM","Weekday · 5–6 PM"],
    ["weekend_AM","Weekend · 8–9 AM"],["weekend_MD","Weekend · 12:30–1:30 PM"],["weekend_PM","Weekend · 5–6 PM"]
  ];
  timeSelect.innerHTML=times.map(([value,label])=>`<option value="${value}">${label}</option>`).join("");
  timeSelect.value="weekday_PM";
  const scenarioOptions=(meta.eligibilityScenarios||[]).map(scenario=>{
    const name=scenario.id==="baseline"?"Baseline":scenario.id;
    return `<option value="${escapeHtml(scenario.id)}">${escapeHtml(name)} · ${escapeHtml(scenario.label)}</option>`;
  }).join("");
  leftSelect.innerHTML=scenarioOptions;
  rightSelect.innerHTML=scenarioOptions;
  leftSelect.value="baseline";
  rightSelect.value=(meta.eligibilityScenarios||[]).some(s=>s.id==="E1")?"E1":"G1";

  compareMap=L.map(mapElement,{zoomControl:true,preferCanvas:false,minZoom:9,maxZoom:16,scrollWheelZoom:false}).setView([40.7128,-74.006],11);
  compareMap.createPane("compareLeftPane");
  compareMap.createPane("compareRightPane");
  const leftPane=compareMap.getPane("compareLeftPane"),rightPane=compareMap.getPane("compareRightPane");
  Object.assign(leftPane.style,{zIndex:310,pointerEvents:"none",width:"100%",height:"100%"});
  Object.assign(rightPane.style,{zIndex:320,pointerEvents:"none",width:"100%",height:"100%"});
  const leftRenderer=L.svg({pane:"compareLeftPane",padding:.5});
  const rightRenderer=L.svg({pane:"compareRightPane",padding:.5});
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",{
    maxZoom:16,attribution:'Tiles © <a href="https://www.esri.com/">Esri</a>'
  }).addTo(compareMap);
  compareLeftLayer=L.geoJSON(tractsData,{pane:"compareLeftPane",renderer:leftRenderer,interactive:false,smoothFactor:0,style:feature=>comparisonTractStyle(feature.properties,leftSelect.value,timeSelect.value,"compareLeftPane")}).addTo(compareMap);
  compareRightLayer=L.geoJSON(tractsData,{pane:"compareRightPane",renderer:rightRenderer,interactive:false,smoothFactor:0,style:feature=>comparisonTractStyle(feature.properties,rightSelect.value,timeSelect.value,"compareRightPane")}).addTo(compareMap);
  const leftSwipeLayer=L.layerGroup().addTo(compareMap);
  const rightSwipeLayer=L.layerGroup().addTo(compareMap);
  leftSwipeLayer.getContainer=()=>leftPane;
  rightSwipeLayer.getContainer=()=>rightPane;
  compareControl=L.control.sideBySide(leftSwipeLayer,rightSwipeLayer,{thumbSize:48,padding:5}).addTo(compareMap);
  compareControl._range.setAttribute("aria-label","Drag to compare the left and right scenarios");
  L.DomEvent.disableClickPropagation(compareControl._container);
  L.DomEvent.disableScrollPropagation(compareControl._container);
  L.DomEvent.on(compareControl._range,"pointerdown pointermove pointerup pointercancel",L.DomEvent.stopPropagation);

  [timeSelect,leftSelect,rightSelect].forEach(control=>control.addEventListener("change",refreshComparisonMap));
  refreshComparisonMap();
  setTimeout(()=>compareMap.invalidateSize(),0);
  if("IntersectionObserver" in window){
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){compareMap.invalidateSize();observer.disconnect()}},{threshold:.1});
    observer.observe(mapElement);
  }
}

function comparisonScenarioScore(properties,scenarioId,time){
  const day=time.startsWith("weekend")?"weekend":"weekday";
  return Number(properties?.scenarios?.[scenarioId]?.[day])||0;
}

function comparisonTractStyle(properties,scenarioId,time,pane){
  return {pane,stroke:false,fill:true,fillColor:accessibilityColorForScore(properties,comparisonScenarioScore(properties,scenarioId,time)),fillOpacity:.82};
}

function refreshComparisonMap(){
  if(!compareMap||!compareLeftLayer||!compareRightLayer)return;
  const time=document.querySelector("#compare-time").value;
  const leftId=document.querySelector("#compare-left-scenario").value;
  const rightId=document.querySelector("#compare-right-scenario").value;
  compareLeftLayer.setStyle(feature=>comparisonTractStyle(feature.properties,leftId,time,"compareLeftPane"));
  compareRightLayer.setStyle(feature=>comparisonTractStyle(feature.properties,rightId,time,"compareRightPane"));
  document.querySelector("#compare-left-label").textContent=comparisonScenarioLabel(leftId);
  document.querySelector("#compare-right-label").textContent=comparisonScenarioLabel(rightId);
}

function comparisonScenarioLabel(id){
  const scenario=(meta.eligibilityScenarios||[]).find(item=>item.id===id);
  return id==="baseline"?"Baseline · all recorded facilities":`${id} · ${scenario?.label||id}`;
}

function tractScenarioScore(properties){
  const day=document.querySelector("#time-window").value.startsWith("weekend")?"weekend":"weekday";
  return Number(properties?.scenarios?.[activeEligibilityScenario.id]?.[day])||0;
}

function tractScenarioPercentile(score){
  if(!score||!tractsData)return 0;
  const values=tractsData.features
    .filter(feature=>feature.properties.flow&&!feature.properties.veryLowActivity)
    .map(feature=>tractScenarioScore(feature.properties))
    .filter(value=>Number.isFinite(value)&&value>0)
    .sort((a,b)=>a-b);
  if(!values.length)return 0;
  let lo=0,hi=values.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(values[mid]<=score)lo=mid+1;else hi=mid}
  return Math.max(1,Math.min(100,Math.round(lo/values.length*100)));
}

function renderScenarioResult(tract){
  const el=document.querySelector("#scenario-result");
  if(!tract){el.innerHTML="";return}
  const p=tract.properties;
  if(p.veryLowActivity){
    el.innerHTML='<span class="scenario-result-label term" tabindex="0" data-tooltip="The paper masks the lowest 2% of complete tracts by weekly pedestrian activity to avoid scores inflated by very small demand denominators.">Selected tract · gray mask</span><strong>Extreme low pedestrian activity</strong>';
    return;
  }
  const score=tractScenarioScore(p),percentile=tractScenarioPercentile(score);
  el.innerHTML=`<span class="scenario-result-label term" tabindex="0" data-tooltip="Tract-level access under ${escapeHtml(activeEligibilityScenario.definition)}.">${escapeHtml(activeEligibilityScenario.id==="baseline"?"Baseline":activeEligibilityScenario.id)} tract scenario</span><strong>${(score*100000).toFixed(2)} ×10⁵ · ${ordinal(percentile)} percentile</strong>`;
}

function roadPercentile(score,time){
  if(!score)return 0;
  const breaks=meta.percentileBreaks[`score_${time}`]||[];
  let rank=1;
  for(let i=1;i<breaks.length;i++){if(score>=breaks[i])rank=i;else break}
  return Math.max(1,Math.min(100,rank));
}
function ordinal(n){const mod100=n%100;if(mod100>=11&&mod100<=13)return `${n}th`;return `${n}${n%10===1?"st":n%10===2?"nd":n%10===3?"rd":"th"}`}

function findTract(lon,lat){
  if(!tractsData)return null;
  return tractsData.features.find(f=>pointInGeometry([lon,lat],f.geometry));
}
function pointInGeometry(point,geometry){
  const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates;
  return polygons.some(poly=>pointInRing(point,poly[0])&&!poly.slice(1).some(hole=>pointInRing(point,hole)));
}
function pointInRing([x,y],ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside}return inside}

function openResultsLoading(){
  document.querySelector("#result-location").textContent=currentLabel;
  document.querySelector("#road-status").textContent="Reading the road…";
  document.querySelector("#road-context").textContent="Nearest modeled road";
  resultPanel.classList.add("open");resultPanel.setAttribute("aria-hidden","false");
}
function showMapError(message){openResultsLoading();document.querySelector("#road-status").textContent="Location unavailable";document.querySelector("#road-context").textContent=message}
function setSearchBusy(busy){const b=document.querySelector(".search-button");b.disabled=busy;b.style.opacity=busy?.55:1}
function haversine(a,b,c,d){const R=6371000,p=Math.PI/180,x=(c-a)*p,y=(d-b)*p;const h=Math.sin(x/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(y/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function fmt(n,d=0){return Number(n).toFixed(d)}
function escapeHtml(s=""){return String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]))}
