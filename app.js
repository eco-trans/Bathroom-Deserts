const TIME_FIELDS = ["weekday_AM","weekday_MD","weekday_PM","weekend_AM","weekend_MD","weekend_PM"];
const DATA_VERSION = "16";
const SCORE_INDEX = {weekday_AM:3,weekday_MD:4,weekday_PM:5,weekend_AM:6,weekend_MD:7,weekend_PM:8};
const COLORS = {zero:"#d81b60",low:"#ff7a00",served:"#6d28d9"};
let activeEligibilityScenario={id:"baseline",family:"Baseline",label:"All recorded facilities",definition:"All public and semi-public restroom candidates in the study inventory"};
let activeMapUnit="tract";

const map = L.map("map", {zoomControl:false, preferCanvas:true, minZoom:9, maxZoom:19}).setView([40.7128,-74.006], 10);
map.createPane("surfacePane");
map.getPane("surfacePane").style.zIndex=250;
map.getPane("surfacePane").style.pointerEvents="none";
map.createPane("roadPane");
map.getPane("roadPane").style.zIndex=650;
map.getPane("roadPane").style.pointerEvents="none";
map.createPane("selectedRoadPane");
map.getPane("selectedRoadPane").style.zIndex=850;
map.getPane("selectedRoadPane").style.pointerEvents="none";
map.createPane("poiPane");
map.getPane("poiPane").style.zIndex=900;
map.getPane("poiPane").style.pointerEvents="auto";
map.createPane("poiTooltipPane");
map.getPane("poiTooltipPane").style.zIndex=950;
map.getPane("poiTooltipPane").style.pointerEvents="none";
L.control.zoom({position:"bottomright"}).addTo(map);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
  maxZoom:19,
  attribution:'Tiles © <a href="https://www.esri.com/">Esri</a>'
}).addTo(map);

let meta, facilities, tractsData, tractLayer, roadsLayer = L.layerGroup({pane:"roadPane"}).addTo(map), facilityLayer = L.layerGroup().addTo(map);
let selectedRoadLayer, currentPoint, currentLabel = "Selected point";
let analysisToken=0;
let roadRenderToken=0;
const tileCache = new Map();
const availableTiles = new Set();
const resultPanel = document.querySelector("#result-panel");

Promise.all([
  fetch(`data/meta.json?v=${DATA_VERSION}`).then(r=>r.json()),
  fetch(`data/facilities.json?v=${DATA_VERSION}`).then(r=>r.json()),
  fetch(`data/tracts.geojson?v=${DATA_VERSION}`).then(r=>r.json())
]).then(([m,f,t])=>{
  meta=m; facilities=f; tractsData=t;
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
  if(activeMapUnit==="road"){
    map.removeLayer(tractLayer);
    renderVisibleRoads();
  }
}).catch(()=>showMapError("The research layers could not be loaded."));

function accessibilityColor(properties){
  if(properties.veryLowActivity)return "#a6abb2";
  if(!properties.flow)return "#3f4652";
  const value=Math.max(0,Math.min(9.81,tractScenarioScore(properties)*100000));
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
map.on("click",e=>{currentLabel="Map selection";analyzePoint(e.latlng.lat,e.latlng.lng,map.getZoom()<15)});
map.on("moveend",()=>{if(activeMapUnit==="road")renderVisibleRoads()});

async function analyzePoint(lat,lon,focus){
  if(!meta)return showMapError("The research layers are still loading. Try again in a moment.");
  const token=++analysisToken;
  currentPoint={lat,lon};
  if(focus)map.setView([lat,lon],Math.max(map.getZoom(),15),{animate:false});
  facilityLayer.clearLayers();
  openResultsLoading();
  const roads=await loadRoadNeighborhood(lat,lon);
  if(token!==analysisToken)return;
  const nearest=nearestRoad(lat,lon,roads);
  if(!nearest){showMapError("No modeled road was found near this point.");return}
  const time=document.querySelector("#time-window").value;
  const score=Number(nearest[SCORE_INDEX[time]])||0;
  const threshold=meta.thresholds[`score_${time}`];
  const status=score<=0?"zero":score<=threshold?"low":"served";
  const nearby=nearbyFacilities(lat,lon,time);
  const tract=findTract(lon,lat);
  drawSelection(nearest,status);
  drawFacilities(nearby.slice(0,8));
  if(activeMapUnit==="road")renderVisibleRoads();
  else drawNearbyRoads(lat,lon,roads);
  renderResults({status,score,threshold,nearby,tract,distance:nearest._distance,time});
}

async function loadRoadNeighborhood(lat,lon){
  const tx=Math.floor(lon/meta.tileSize),ty=Math.floor(lat/meta.tileSize);
  const keys=[];
  for(let x=tx-1;x<=tx+1;x++)for(let y=ty-1;y<=ty+1;y++)if(availableTiles.has(`${x}_${y}`))keys.push(`${x}_${y}`);
  const batches=await Promise.all(keys.map(async key=>{
    if(tileCache.has(key))return tileCache.get(key);
    const data=await fetch(`data/roads/${key}.json`).then(r=>r.json());tileCache.set(key,data);return data;
  }));
  return batches.flat();
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

function nearbyFacilities(lat,lon,time){
  const availabilityIndex=time.startsWith("weekday")?(time.endsWith("PM")?7:6):(time.endsWith("PM")?9:8);
  return facilities.map(f=>({...{raw:f},distance:haversine(lat,lon,f[4],f[5])})).filter(x=>x.raw[availabilityIndex]===1&&matchesEligibility(x.raw)&&x.distance<=3000).sort((a,b)=>a.distance-b.distance);
}

function matchesEligibility(f){
  const id=activeEligibilityScenario.id;
  if(id==="baseline")return true;
  const category=normalizeKey(f[14]),condition=normalizeKey(f[11]),ada=normalizeKey(f[10]);
  if(id==="E1")return condition==="free"||category==="shopping_mall";
  if(id==="E2")return condition==="free"||["shopping_mall","grocery"].includes(category);
  if(id==="E3")return condition==="free"||["shopping_mall","grocery","fast_food","pharmacy"].includes(category);
  if(id==="A1")return ada==="fully_accessible";
  if(id==="A2")return ["fully_accessible","partially_accessible"].includes(ada);
  if(id==="A3")return ["fully_accessible","partially_accessible","unknown"].includes(ada);
  if(id==="G1")return f[1]===0&&normalizeKey(f[13]).includes("all_gender");
  return true;
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
    const data=await fetch(`data/roads/${key}.json?v=${DATA_VERSION}`).then(r=>r.json());
    tileCache.set(key,data);
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
  map.getPane("poiPane").style.zIndex=900;
  map.getPane("poiTooltipPane").style.zIndex=950;
  if(selectedRoadLayer)selectedRoadLayer.eachLayer(layer=>layer.bringToFront&&layer.bringToFront());
}

function pointToRoadFast(lat,lon,road){
  const c=road[9][Math.floor(road[9].length/2)];return haversine(lat,lon,c[1],c[0]);
}

function drawFacilities(items){
  facilityLayer.clearLayers();
  items.forEach((item,i)=>{
    const f=item.raw;
    const icon=L.divIcon({className:"facility-marker",iconSize:[13,13],iconAnchor:[6,6]});
    L.marker([f[4],f[5]],{icon,pane:"poiPane"})
      .bindTooltip(`${i+1}. ${escapeHtml(f[2])}`,{pane:"poiTooltipPane",className:"poi-tooltip",direction:"top",offset:[0,-8]})
      .addTo(facilityLayer);
  });
}

function renderResults({status,score,nearby,tract,time}){
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
  const nearest=nearby[0];
  document.querySelector("#nearest-distance").textContent=nearest?formatDistance(nearest.distance):"None";
  document.querySelector("#nearest-kind").textContent=nearest?`~${walkingMinutes(nearest.distance)} min · ${nearest.raw[1]===0?"public":"semi-public"}`:"within 3 km";
  document.querySelector("#option-count").textContent=`${nearby.length} within 3 km`;
  document.querySelector("#facility-list").innerHTML=nearby.length?nearby.slice(0,5).map((item,i)=>facilityHtml(item,i)).join(""):'<div class="empty-options">No recorded-open candidate was found within 3 km for this study window.</div>';
  resultPanel.classList.add("open");resultPanel.setAttribute("aria-hidden","false");
}

function facilityHtml(item,i){
  const f=item.raw,semi=f[1]===1,walk=walkingMinutes(item.distance);
  const access=f[10]&&f[10]!=="Unknown"?f[10]:"Access unknown";
  const condition=semi?"Entry conditional":(f[11]==="free"?"Free entry":humanize(f[11]));
  const facilityTip=semi?"A possible restroom in a business or other non-municipal location; entry can be conditional.":"A restroom recorded in the city’s public-facility inventory.";
  const accessTip=access==="Access unknown"?"The source record does not confirm physical accessibility.":"Recorded physical-accessibility status; conditions were not field-verified in real time.";
  const conditionTip=semi?"Use may require a purchase, code, permission, or staff approval.":"Recorded entry condition for this public facility.";
  return `<article class="facility-item ${semi?"semi":""}"><span class="facility-rank">${i+1}</span><div><h4>${escapeHtml(f[2])}</h4><p>${escapeHtml(f[3]||humanize(f[14]))}</p><div class="facility-tags"><span class="tag term" tabindex="0" data-tooltip="${facilityTip}">${semi?"Semi-public":"Public"}</span><span class="tag term" tabindex="0" data-tooltip="${accessTip}">${escapeHtml(access)}</span><span class="tag term" tabindex="0" data-tooltip="${conditionTip}">${escapeHtml(condition)}</span></div></div><div class="distance">${formatDistance(item.distance)}<small>~${walk} min</small></div></article>`;
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

function walkingMinutes(distance){
  return Math.max(1,Math.round(distance*1.25/1.4/60));
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
  document.querySelector("#facility-list").innerHTML='<div class="empty-options">Loading nearby research records…</div>';
  resultPanel.classList.add("open");resultPanel.setAttribute("aria-hidden","false");
}
function showMapError(message){openResultsLoading();document.querySelector("#road-status").textContent="Location unavailable";document.querySelector("#facility-list").innerHTML=`<div class="empty-options">${escapeHtml(message)}</div>`}
function setSearchBusy(busy){const b=document.querySelector(".search-button");b.disabled=busy;b.style.opacity=busy?.55:1}
function haversine(a,b,c,d){const R=6371000,p=Math.PI/180,x=(c-a)*p,y=(d-b)*p;const h=Math.sin(x/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(y/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function formatDistance(m){return m<1000?`${Math.round(m/10)*10} m`:`${(m/1000).toFixed(1)} km`}
function fmt(n,d=0){return Number(n).toFixed(d)}
function humanize(s=""){return String(s).replaceAll("_"," ").replace(/\b\w/g,c=>c.toUpperCase())}
function normalizeKey(s=""){return String(s).trim().toLowerCase().replaceAll("-","_").replaceAll(" ","_")}
function escapeHtml(s=""){return String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]))}
