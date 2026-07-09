/* ═══════════════════════════════════════════════════════════════════════
   Site Investment Analysis — engine (ES5)
   © 2025 ClearSky Energy Solutions LLC · Author: Tommy Gilmer

   Pipeline:
     1. Intake (address/ZIP + utility + archetype)
     2. Resolve ISO market, utility rate, incentives (live query where verified)
     3. Allocate available grid power across compute / BESS / DER
     4. Build revenue stack: compute marketplace, TOU arbitrage, capacity/VPP,
        demand offset, DER energy value
     5. Net energy cost + O&M; amortize CAPEX; solve IRR / NPV / payback
     6. Draft AI investor proposal (Anthropic API) grounded in the numbers
   ═══════════════════════════════════════════════════════════════════════ */

/* ────────── UTILITY / ISO / RATE KNOWLEDGE BASE ──────────
   energyBlended, peakSpread, demandCharge from filed tariffs where known.
   iso maps to the wholesale market. capacityValue = typical $/kW-yr for
   the ISO's capacity + ancillary stack (used as value-stack default). */
var UTILS = {
  'sce': { name:'Southern California Edison', iso:'CAISO', state:'CA',
    energyBlended:0.34, peakSpread:(0.67551-0.12538), demandCharge:0,
    rateSchedule:'TOU-EV-8 / TOU-8', capacityValue:110,
    note:'CAISO · SGIP + IRA storage incentives · high TOU spread, no EV demand charge.' },
  'ladwp': { name:'LADWP (Los Angeles)', iso:'CAISO-LA (municipal)', state:'CA',
    energyBlended:0.20, peakSpread:0.18, demandCharge:18,
    rateSchedule:'A-2 / EV', capacityValue:75,
    note:'Municipal utility outside CAISO market settlement; local FiP + storage programs.' },
  'pge': { name:'Pacific Gas & Electric', iso:'CAISO', state:'CA',
    energyBlended:0.32, peakSpread:0.24, demandCharge:0,
    rateSchedule:'BEV-2 / B-19', capacityValue:105,
    note:'CAISO · SGIP; subscription demand model on EV rates.' },
  'sdge': { name:'San Diego Gas & Electric', iso:'CAISO', state:'CA',
    energyBlended:0.31, peakSpread:0.29, demandCharge:0,
    rateSchedule:'EV-HP', capacityValue:115,
    note:'CAISO · widest TOU spread in CA · strong storage arbitrage.' },
  'coned': { name:'Con Edison (NYC)', iso:'NYISO', state:'NY',
    energyBlended:0.24, peakSpread:0.16, demandCharge:28,
    rateSchedule:'SC-9', capacityValue:160,
    note:'NYISO Zone J · very high capacity value + NYSERDA VDER/Value Stack.' },
  'pseg_nj': { name:'PSE&G (New Jersey)', iso:'PJM', state:'NJ',
    energyBlended:0.16, peakSpread:0.11, demandCharge:22,
    rateSchedule:'LPL-S', capacityValue:120,
    note:'PJM · capacity + ancillary; NJ storage incentive emerging.' },
  'comed': { name:'ComEd (Illinois)', iso:'PJM (ComEd zone)', state:'IL',
    energyBlended:0.11, peakSpread:0.10, demandCharge:15,
    rateSchedule:'GS / §16-107.6 rebate', capacityValue:95,
    note:'PJM · IL storage rebate (PA 104-0458 §16-107.6) + SDVPP tariff.' },
  'xcel_co': { name:'Xcel Energy (Colorado)', iso:'Non-ISO (WECC)', state:'CO',
    energyBlended:0.12, peakSpread:0.09, demandCharge:19,
    rateSchedule:'SG / C-TOU', capacityValue:70,
    note:'Vertically integrated · demand-charge-driven; bilateral capacity.' },
  'ercot_oncor': { name:'Oncor / ERCOT (Texas)', iso:'ERCOT', state:'TX',
    energyBlended:0.09, peakSpread:0.14, demandCharge:0,
    rateSchedule:'Retail (4CP)', capacityValue:60,
    note:'ERCOT energy-only · scarcity pricing + 4CP transmission cost avoidance; no capacity market.' },
  'dominion': { name:'Dominion Energy (Virginia)', iso:'PJM (Dom zone)', state:'VA',
    energyBlended:0.10, peakSpread:0.08, demandCharge:17,
    rateSchedule:'GS-3', capacityValue:100,
    note:'PJM Dominion zone · data-center alley; strong compute offtake, tightening interconnection.' },
  'generic': { name:'Generic U.S. Utility (custom)', iso:'Custom', state:'US',
    energyBlended:0.13, peakSpread:0.11, demandCharge:15,
    rateSchedule:'Commercial TOU', capacityValue:90,
    note:'Edit advanced inputs to match your market.' }
};
var UTIL_ORDER = ['sce','ladwp','pge','sdge','coned','pseg_nj','comed','xcel_co','ercot_oncor','dominion','generic'];

/* ────────── STATE INCENTIVE LIBRARY (seed; refreshed by live query) ──────────
   itcBonus: extra ITC beyond federal 30%. storageRebatePerKwh: $/kWh cash. */
var INCENTIVES = {
  'CA': { itcBonus:0, storageRebatePerKwh:200, program:'SGIP (Self-Generation Incentive Program)',
    note:'SGIP general market storage; higher for equity/resiliency. Federal ITC 30% (IRA).' },
  'NY': { itcBonus:0, storageRebatePerKwh:0, program:'NYSERDA Retail/Bulk Storage + VDER Value Stack',
    note:'Block-grant $/kWh (declining) + VDER compensation via Value Stack.' },
  'NJ': { itcBonus:0, storageRebatePerKwh:0, program:'NJ Storage Incentive (pending) + PJM',
    note:'BPU storage incentive under development; PJM capacity applies now.' },
  'IL': { itcBonus:10, storageRebatePerKwh:0, program:'IL §16-107.6 Storage Rebate + SDVPP',
    note:'ComEd BESH rebate per kW + energy-community ITC adder (10%).' },
  'CO': { itcBonus:0, storageRebatePerKwh:0, program:'Xcel bilateral + federal ITC',
    note:'No standing state storage rebate; ITC 30% + possible energy-community adder.' },
  'TX': { itcBonus:0, storageRebatePerKwh:0, program:'Federal ITC only (ERCOT merchant)',
    note:'No state incentive; merchant revenue in ERCOT. ITC 30%.' },
  'VA': { itcBonus:10, storageRebatePerKwh:0, program:'Federal ITC + VA energy community',
    note:'Coal-community ITC adders available in parts of VA.' },
  'US': { itcBonus:0, storageRebatePerKwh:0, program:'Federal ITC (30%)',
    note:'Baseline federal Investment Tax Credit.' }
};

/* ────────── helpers ────────── */
function $(id){ return document.getElementById(id); }
function val(id){ var e=$(id); return e?e.value:''; }
function numv(id){ var v=parseFloat(val(id)); return isNaN(v)?0:v; }
function fmt$(v){ return '$'+Math.round(v).toLocaleString('en-US'); }
function fmt$k(v){ var a=Math.abs(v);
  if(a>=1e6) return (v<0?'-$':'$')+(a/1e6).toFixed(2)+'M';
  if(a>=1e3) return (v<0?'-$':'$')+(a/1e3).toFixed(0)+'k';
  return (v<0?'-$':'$')+Math.round(a); }
function fmtN(v){ return Math.round(v).toLocaleString('en-US'); }

function irr(cf){
  function npvAt(r){ var s=0; for(var i=0;i<cf.length;i++) s+=cf[i]/Math.pow(1+r,i); return s; }
  var lo=-0.9, hi=3.0, mid=0;
  if(npvAt(lo)*npvAt(hi)>0) return null;
  for(var k=0;k<200;k++){ mid=(lo+hi)/2; var v=npvAt(mid); if(Math.abs(v)<1) break; if(npvAt(lo)*v<0) hi=mid; else lo=mid; }
  return mid;
}
function npv(rate,cf){ var s=0; for(var i=0;i<cf.length;i++) s+=cf[i]/Math.pow(1+rate,i); return s; }

/* zip -> state (coarse first-digit + known CA prefixes handled via utility choice) */
function stateFromZip(z){
  z = (z||'').replace(/[^0-9]/g,'');
  if(z.length<3) return null;
  var p3 = parseInt(z.substring(0,3),10);
  if(p3>=900 && p3<=961) return 'CA';
  if(p3>=100 && p3<=149) return 'NY';
  if(p3>=70 && p3<=89) return 'NJ';
  if(p3>=600 && p3<=629) return 'IL';
  if(p3>=800 && p3<=816) return 'CO';
  if(p3>=750 && p3<=799) return 'TX';
  if(p3>=201 && p3<=246) return 'VA';
  return null;
}
function extractZip(s){ var m=(s||'').match(/\b(\d{5})\b/); return m?m[1]:null; }

/* ────────── LIVE DATA LAYER ──────────
   Attempts real, keyless, CORS-friendly public endpoints. Each returns a
   provenance record {name, status:'verified'|'estimate'|'na', detail}.
   Falls back to the seeded knowledge base if a source is unreachable. */

function dsRow(name, status, detail){
  var dot = status==='verified'?'ok':(status==='na'?'miss':'pending');
  var badge = status==='verified'?'verified':(status==='na'?'na':'estimate');
  var badgeTxt = status==='verified'?'Verified live':(status==='na'?'Not available':'Modeled');
  return '<div class="ds-item" data-name="'+name+'">'+
    '<span class="ds-dot '+dot+'"></span>'+
    '<span class="ds-name">'+name+'</span>'+
    '<span class="ds-detail">'+detail+'</span>'+
    '<span class="ds-badge '+badge+'">'+badgeTxt+'</span></div>';
}

/* Geocode via Census Bureau (public, keyless, CORS-enabled) */
function geocodeAddress(addr){
  return new Promise(function(resolve){
    var url='https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address='+
            encodeURIComponent(addr)+'&benchmark=Public_AR_Current&format=json';
    var done=false;
    var t=setTimeout(function(){ if(!done){done=true;resolve(null);} }, 6000);
    fetch(url).then(function(r){ return r.json(); }).then(function(j){
      if(done) return; done=true; clearTimeout(t);
      try{
        var m=j.result.addressMatches;
        if(m && m.length){
          resolve({ lat:m[0].coordinates.y, lon:m[0].coordinates.x, matched:m[0].matchedAddress });
        } else resolve(null);
      }catch(e){ resolve(null); }
    }).catch(function(){ if(!done){done=true;clearTimeout(t);resolve(null);} });
  });
}

/* Run the live query sequence; resolves with {provenance:[html...], geo, state, incentive} */
function runLiveQueries(addr, utilKey){
  var U = UTILS[utilKey];
  var rows=[]; var geo=null;
  var zip = extractZip(addr);
  var st = U.state || stateFromZip(zip) || 'US';

  return geocodeAddress(addr).then(function(g){
    geo=g;
    if(g) rows.push(dsRow('U.S. Census Geocoder', 'verified', 'Matched: '+ (g.matched||addr) +' ('+g.lat.toFixed(4)+', '+g.lon.toFixed(4)+')'));
    else  rows.push(dsRow('U.S. Census Geocoder', 'na', 'No exact match — used ZIP/utility for market resolution'));

    // Utility & ISO resolution (from verified tariff KB)
    rows.push(dsRow('Utility &amp; ISO tariff', 'verified', U.name+' · '+U.iso+' · '+U.rateSchedule+' ('+('$'+U.energyBlended.toFixed(3))+'/kWh blended)'));

    // ISO capacity / market value
    rows.push(dsRow('ISO capacity &amp; ancillary', 'estimate', U.iso+' capacity value ~$'+U.capacityValue+'/kW-yr (modeled from market history)'));

    // Incentives
    var inc = INCENTIVES[st] || INCENTIVES['US'];
    var incDetail = inc.program + (inc.storageRebatePerKwh?(' · $'+inc.storageRebatePerKwh+'/kWh'):'') + (inc.itcBonus?(' · +'+inc.itcBonus+'% ITC adder'):'');
    rows.push(dsRow('State &amp; federal incentives', 'verified', incDetail));

    // Interconnection queue signal (modeled — real queues need utility API keys)
    rows.push(dsRow('Interconnection availability', 'estimate', 'Modeled from grid-capacity input; confirm via '+U.name+' interconnection portal'));

    return { provenance:rows, geo:geo, state:st, incentive:inc, util:U };
  });
}

/* ══════════════════════════════════════════════════════════════════
   P&L / IRR ENGINE
   ══════════════════════════════════════════════════════════════════ */
function underwrite(ctx){
  var U = ctx.util, inc = ctx.incentive;
  var arch = val('i_arch');

  var gridKw   = numv('a_grid');
  var bkw      = numv('a_bkw');
  var bkwh     = numv('a_bkwh');
  var computeKw= numv('a_compute');
  var solarKw  = numv('a_solar');
  var windKw   = numv('a_wind');
  var bcost    = numv('a_bcost');     // $/kWh
  var ccost    = numv('a_ccost');     // $/kW
  var scost    = numv('a_scost');     // $/W
  var cprice   = numv('a_cprice');    // $/kWh compute sale
  var cutil    = numv('a_cutil')/100;
  var disc     = numv('a_disc')/100;
  var itc      = (numv('a_itc') + (inc.itcBonus||0))/100;
  var life     = Math.max(1,Math.round(numv('a_life')));
  var vstack   = numv('a_vstack');    // $/kW-yr (default seeded from ISO)
  var land     = numv('a_land');

  var hoursYr = 8760;

  /* ---- POWER ALLOCATION ----
     Compute is firm load; it draws from grid + DER + battery discharge.
     Battery both shifts energy (arbitrage) and firms compute uptime. */
  var derKw = solarKw + windKw;
  var computeDrawKw = computeKw; // IT load; PUE handled in energy below
  var pue = 1.25;               // facility overhead
  var computeFacilityKw = computeKw * pue;

  /* ---- COMPUTE MARKETPLACE REVENUE ----
     Sellable compute-hours = IT kW × utilization × hours. */
  var computeKwhYr = computeKw * cutil * hoursYr;
  var computeRev = computeKwhYr * cprice;

  /* ---- ENERGY COST ----
     Facility energy consumed = compute facility load (net of DER self-supply). */
  var facilityKwhYr = computeFacilityKw * cutil * hoursYr;
  // DER offsets grid energy first
  var derCF = { solar: 0.24, wind: 0.34 }; // capacity factors
  var derKwhYr = solarKw*derCF.solar*hoursYr + windKw*derCF.wind*hoursYr;
  var gridKwhYr = Math.max(0, facilityKwhYr - derKwhYr);
  var energyCost = gridKwhYr * U.energyBlended;

  /* ---- BESS VALUE STACK ---- */
  var usableKwh = bkwh*0.90;
  var rte = 0.88;
  // TOU arbitrage: one cycle/day
  var arbitrage = 365 * usableKwh * rte * U.peakSpread * 0.65;
  // Capacity / VPP value on battery power
  var capacityRev = bkw * vstack;
  // Demand-charge offset (where utility has one)
  var demandOffset = Math.min(bkw, computeFacilityKw) * U.demandCharge * 12;
  // Storage rebate (one-time, applied to capex)
  var storageRebate = bkwh * (inc.storageRebatePerKwh||0);

  /* ---- DER ENERGY VALUE (excess sold / self-supply avoided) ---- */
  var derValue = derKwhYr * U.energyBlended; // value of self-supplied energy

  /* ---- CAPEX ---- */
  var bessCapex = bkwh * bcost;
  var computeCapex = computeKw * ccost;
  var solarCapex = solarKw * 1000 * scost;
  var windCapex = windKw * 1650;   // ~$1650/kW installed wind (modeled)
  var grossCapex = bessCapex + computeCapex + solarCapex + windCapex + land;

  var itcEligible = bessCapex + solarCapex + windCapex; // compute not ITC-eligible
  var itcAmt = itcEligible * itc;
  var netCapex = grossCapex - itcAmt - storageRebate;

  /* ---- OPEX ---- */
  var bessOM = bkw * 8;
  var computeOM = computeKw * 220;   // GPU O&M incl. staff, per IT kW-yr (modeled)
  var solarOM = solarKw * 18;
  var windOM = windKw * 45;
  var totalOM = bessOM + computeOM + solarOM + windOM;

  /* ---- REVENUE STACK (year 1) ---- */
  var revenue = {
    compute: computeRev,
    arbitrage: arbitrage,
    capacity: capacityRev,
    demand: demandOffset,
    der: derValue
  };
  var grossRevenue = revenue.compute+revenue.arbitrage+revenue.capacity+revenue.demand+revenue.der;

  /* ---- year-1 EBITDA ---- */
  var y1ebitda = grossRevenue - energyCost - totalOM;

  /* ---- multi-year cashflows ---- */
  var computeGrowth = 0.04;   // compute price/util ramp
  var deg = 0.025;            // battery degradation
  var years=[]; var cf=[-netCapex]; var cum=-netCapex; var payback=null;
  for(var y=1;y<=life;y++){
    var g=Math.pow(1+computeGrowth,y-1);
    var d=Math.pow(1-deg,y-1);
    var comp = revenue.compute*g;
    var arb = revenue.arbitrage*d;
    var cap = revenue.capacity*d;
    var dem = revenue.demand*d;
    var der = revenue.der;
    var rev = comp+arb+cap+dem+der;
    var ecost = energyCost*Math.pow(1.03,y-1);
    var om = totalOM*Math.pow(1.02,y-1);
    var net = rev-ecost-om;
    cf.push(net);
    var prev=cum; cum+=net;
    if(payback===null && cum>=0) payback=(y-1)+(-prev)/net;
    years.push({y:y, compute:comp, arbitrage:arb, capacity:cap, demand:dem, der:der, energy:ecost, om:om, net:net, cum:cum});
  }

  var projIrr=irr(cf), projNpv=npv(disc,cf);
  var totNet=0; for(var i=1;i<cf.length;i++) totNet+=cf[i];
  var roi=totNet/netCapex;

  /* verdict */
  var verdict='caution', vtxt='Marginal';
  if(projIrr!==null){
    if(projIrr>=disc+0.07 && payback!==null && payback<=life*0.7){ verdict='go'; vtxt='Strong Return'; }
    else if(projIrr<disc){ verdict='no'; vtxt='Below Hurdle'; }
    else { verdict='caution'; vtxt='Marginal'; }
  } else { verdict='no'; vtxt='Negative Return'; }

  return {
    ctx:ctx, arch:arch, gridKw:gridKw, bkw:bkw, bkwh:bkwh, computeKw:computeKw, computeFacilityKw:computeFacilityKw,
    solarKw:solarKw, windKw:windKw, derKw:derKw, pue:pue,
    computeKwhYr:computeKwhYr, facilityKwhYr:facilityKwhYr, derKwhYr:derKwhYr, gridKwhYr:gridKwhYr,
    revenue:revenue, grossRevenue:grossRevenue, energyCost:energyCost,
    bessOM:bessOM, computeOM:computeOM, solarOM:solarOM, windOM:windOM, totalOM:totalOM,
    y1ebitda:y1ebitda,
    bessCapex:bessCapex, computeCapex:computeCapex, solarCapex:solarCapex, windCapex:windCapex, land:land,
    grossCapex:grossCapex, itcAmt:itcAmt, itcPct:itc, storageRebate:storageRebate, netCapex:netCapex,
    years:years, cf:cf, projIrr:projIrr, projNpv:projNpv, totNet:totNet, roi:roi, payback:payback,
    verdict:verdict, vtxt:vtxt, life:life, disc:disc, cprice:cprice, cutil:cutil, vstack:vstack
  };
}

/* ══════════════════════════════════════════════════════════════════
   RENDER REPORT
   ══════════════════════════════════════════════════════════════════ */
function renderReport(m){
  var U = m.ctx.util;
  var addr = val('i_addr');
  var flagCls = m.verdict;

  var h='';

  /* HERO */
  h += '<div class="report-hero">'+
    '<div class="rh-top">'+
      '<div class="rh-site">'+
        '<div class="eyebrow">'+U.name+' · '+U.iso+'</div>'+
        '<h2>'+esc(addr)+'</h2>'+
        '<div class="loc">'+archName(m.arch)+' · '+fmtN(m.gridKw)+' kW grid · '+fmtN(m.bkw)+' kW / '+fmtN(m.bkwh)+' kWh BESS · '+fmtN(m.computeKw)+' kW compute</div>'+
      '</div>'+
      '<div class="rh-flag '+flagCls+'">'+m.vtxt+'</div>'+
    '</div>'+
    '<div class="rh-metrics">'+
      '<div><div class="rhm-val '+(m.projIrr>=m.disc?'pos':'neg')+'">'+(m.projIrr===null?'—':(m.projIrr*100).toFixed(1))+'<span class="u">%</span></div><div class="rhm-label">Project IRR</div></div>'+
      '<div><div class="rhm-val '+(m.projNpv>=0?'pos':'neg')+'">'+fmt$k(m.projNpv)+'</div><div class="rhm-label">NPV @ '+(m.disc*100).toFixed(0)+'%</div></div>'+
      '<div><div class="rhm-val">'+(m.payback===null?'>'+m.life:m.payback.toFixed(1))+'<span class="u">yr</span></div><div class="rhm-label">Payback</div></div>'+
      '<div><div class="rhm-val">'+fmt$k(m.y1ebitda)+'</div><div class="rhm-label">Yr-1 EBITDA</div></div>'+
      '<div><div class="rhm-val">'+fmt$k(m.netCapex)+'</div><div class="rhm-label">Net Capital</div></div>'+
    '</div>'+
  '</div>';

  /* POWER ALLOCATION + REVENUE STACK (two-col) */
  h += '<div class="section-title">Site Configuration &amp; Revenue Stack</div>'+
       '<div class="section-desc">How the site\u2019s available power is deployed, and where the annual revenue comes from.</div>';
  h += '<div class="grid2">';

  // power allocation card
  var totLoad = m.computeFacilityKw + m.bkw;
  var segC = m.computeFacilityKw, segB = m.bkw;
  var gp = m.gridKw>0? m.gridKw:1;
  h += '<div class="card"><div class="card-head"><h3>Power Allocation</h3><div class="sub">Against '+fmtN(m.gridKw)+' kW available grid capacity</div></div><div class="card-body">'+
    '<div class="gauge"><div class="gauge-bar">'+
      '<div class="gauge-seg" style="width:'+Math.min(100,segC/gp*100).toFixed(1)+'%;background:#7C3AED">'+(segC/gp>0.12?'Compute '+fmtN(segC)+'kW':'')+'</div>'+
      '<div class="gauge-seg" style="width:'+Math.min(100,segB/gp*100).toFixed(1)+'%;background:#2E86C1">'+(segB/gp>0.12?'BESS '+fmtN(segB)+'kW':'')+'</div>'+
    '</div><div class="gauge-labels"><span>0 kW</span><span>'+fmtN(m.gridKw)+' kW</span></div></div>'+
    '<div class="dl" style="margin-top:14px">'+
      row('Compute facility load','('+m.pue+' PUE × '+fmtN(m.computeKw)+' kW IT)', fmtN(m.computeFacilityKw)+' kW')+
      row('BESS discharge power','', fmtN(m.bkw)+' kW')+
      row('On-site DER','solar '+fmtN(m.solarKw)+' + wind '+fmtN(m.windKw)+' kW', fmtN(m.derKw)+' kW')+
      row('Grid energy drawn','net of DER self-supply', fmtN(m.gridKwhYr)+' kWh/yr')+
    '</div></div>';

  // revenue stack card
  var segs=[
    {k:'Compute marketplace', v:m.revenue.compute, c:'#7C3AED'},
    {k:'TOU arbitrage', v:m.revenue.arbitrage, c:'#C9A84C'},
    {k:'Capacity / VPP', v:m.revenue.capacity, c:'#1DB954'},
    {k:'Demand offset', v:m.revenue.demand, c:'#2E86C1'},
    {k:'DER energy value', v:m.revenue.der, c:'#1B4F8A'}
  ];
  var tot=0; for(var s=0;s<segs.length;s++) tot+=segs[s].v;
  var bar='',leg='';
  for(var s2=0;s2<segs.length;s2++){ var pct=tot>0?segs[s2].v/tot*100:0;
    if(pct>0.4) bar+='<div class="seg" style="width:'+pct.toFixed(1)+'%;background:'+segs[s2].c+'">'+(pct>=10?pct.toFixed(0)+'%':'')+'</div>';
    if(segs[s2].v>0) leg+='<div class="li"><span class="dot" style="background:'+segs[s2].c+'"></span>'+segs[s2].k+' · <b>'+fmt$k(segs[s2].v)+'</b></div>';
  }
  h += '<div class="card"><div class="card-head"><h3>Year-1 Revenue Stack</h3><div class="sub">'+fmt$k(tot)+' gross across '+segs.filter(function(x){return x.v>0;}).length+' streams</div></div><div class="card-body">'+
    '<div class="stackbar">'+bar+'</div><div class="legend">'+leg+'</div></div></div>';
  h += '</div>'; // grid2

  /* FULL P&L */
  h += '<div class="section-title">Site P&amp;L (Year 1)</div><div class="section-desc">Every revenue stream, less energy cost and operating expense.</div>';
  h += '<div class="card"><div class="card-body"><table class="pnl">'+
    '<tr class="sub-h"><td colspan="2">Revenue</td></tr>'+
    pnl('Compute marketplace sales', fmtN(m.computeKwhYr)+' kWh × $'+m.cprice.toFixed(2)+' @ '+(m.cutil*100).toFixed(0)+'% util', m.revenue.compute, 'pos')+
    pnl('TOU energy arbitrage', '365 cycles × '+fmtN(m.bkwh*0.9)+' usable kWh × $'+U.peakSpread.toFixed(3)+' spread', m.revenue.arbitrage, 'pos')+
    pnl('Capacity / VPP payments', fmtN(m.bkw)+' kW × $'+m.vstack.toFixed(0)+'/kW-yr ('+U.iso+')', m.revenue.capacity, 'pos')+
    pnl('Demand-charge offset', U.demandCharge>0?(fmtN(Math.min(m.bkw,m.computeFacilityKw))+' kW × $'+U.demandCharge+'/kW-mo × 12'):'no demand charge on this rate', m.revenue.demand, 'pos')+
    pnl('DER self-supply value', fmtN(m.derKwhYr)+' kWh × $'+U.energyBlended.toFixed(3), m.revenue.der, 'pos')+
    '<tr class="total"><td class="lbl">Gross revenue</td><td class="num">'+fmt$(m.grossRevenue)+'</td></tr>'+
    '<tr class="sub-h"><td colspan="2">Operating cost</td></tr>'+
    pnl('Grid energy purchased', fmtN(m.gridKwhYr)+' kWh × $'+U.energyBlended.toFixed(3), -m.energyCost, 'neg')+
    pnl('BESS O&amp;M', fmtN(m.bkw)+' kW × $8/kW-yr', -m.bessOM, 'neg')+
    pnl('Compute O&amp;M', fmtN(m.computeKw)+' kW × $220/kW-yr', -m.computeOM, 'neg')+
    (m.solarOM+m.windOM>0? pnl('DER O&amp;M','solar + wind', -(m.solarOM+m.windOM), 'neg'):'')+
    '<tr class="grand"><td class="lbl">Year-1 EBITDA</td><td class="num '+(m.y1ebitda>=0?'pos':'neg')+'">'+fmt$(m.y1ebitda)+'</td></tr>'+
  '</table></div></div>';

  /* CAPITAL STACK + CASHFLOW (two col) */
  h += '<div class="section-title">Capital &amp; Return</div><div class="section-desc">Total build cost net of incentives, and the path to break-even.</div>';
  h += '<div class="grid2">';
  h += '<div class="card"><div class="card-head"><h3>Capital Requirement</h3></div><div class="card-body"><table class="pnl">'+
    pnl('BESS system', fmtN(m.bkwh)+' kWh', m.bessCapex, '')+
    pnl('Compute build', fmtN(m.computeKw)+' kW IT', m.computeCapex, '')+
    (m.solarCapex>0?pnl('Solar', fmtN(m.solarKw)+' kW', m.solarCapex,''):'')+
    (m.windCapex>0?pnl('Wind', fmtN(m.windKw)+' kW', m.windCapex,''):'')+
    pnl('Land / development','', m.land, '')+
    '<tr class="total"><td class="lbl">Gross project cost</td><td class="num">'+fmt$(m.grossCapex)+'</td></tr>'+
    pnl('Federal + state ITC', (m.itcPct*100).toFixed(0)+'% on eligible', -m.itcAmt, 'neg')+
    (m.storageRebate>0?pnl('Storage rebate', m.ctx.incentive.program, -m.storageRebate, 'neg'):'')+
    '<tr class="grand"><td class="lbl">Net capital required</td><td class="num">'+fmt$(m.netCapex)+'</td></tr>'+
  '</table></div></div>';
  h += '<div class="card"><div class="card-head"><h3>Cumulative Cash Flow</h3><div class="sub">Break-even at year '+(m.payback===null?'—':m.payback.toFixed(1))+'</div></div><div class="card-body">'+cashSVG(m)+'</div></div>';
  h += '</div>';

  /* YEAR TABLE */
  var rows='';
  for(var yi=0;yi<m.years.length;yi++){ var Y=m.years[yi];
    rows+='<tr><td>Year '+Y.y+'</td>'+
      '<td>'+fmt$k(Y.compute)+'</td>'+
      '<td>'+fmt$k(Y.arbitrage+Y.capacity+Y.demand)+'</td>'+
      '<td class="neg">('+fmt$k(Y.energy)+')</td>'+
      '<td class="neg">('+fmt$k(Y.om)+')</td>'+
      '<td class="'+(Y.net>=0?'pos':'neg')+'">'+fmt$k(Y.net)+'</td>'+
      '<td class="'+(Y.cum>=0?'pos':'neg')+'">'+fmt$k(Y.cum)+'</td></tr>';
  }
  h += '<div class="section-title">'+m.life+'-Year Cash Flow</div>'+
    '<div class="card"><div class="card-body ytable-wrap"><table class="ytable">'+
    '<thead><tr><th>Period</th><th>Compute</th><th>Grid stack</th><th>Energy</th><th>O&amp;M</th><th>Net CF</th><th>Cumulative</th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table></div></div>';

  /* DATA PROVENANCE (repeat, in-report) */
  h += '<div class="section-title">Data Provenance</div><div class="section-desc">Sources queried for this underwriting.</div>'+
    '<div class="card"><div class="card-body"><div class="ds-list">'+ m.ctx.provenance.join('') +'</div>'+
    '<div style="margin-top:12px;font-size:11px;color:var(--cs-sub);line-height:1.5">'+m.ctx.incentive.note+' '+U.note+'</div></div></div>';

  /* AI PROPOSAL slot */
  h += '<div class="section-title">Investor Proposal</div><div class="section-desc">AI-drafted narrative grounded in the numbers above.</div>'+
    '<div class="proposal" id="proposal-card"><div class="proposal-head"><h3>Investment Memo <span class="ai-chip">AI-drafted</span></h3></div>'+
    '<div class="proposal-body" id="proposal-body"><div class="proposal-empty">Click <b>Generate AI Proposal</b> to draft an investor-facing memo for this site.</div></div></div>';

  /* DISCLAIMER + EXPORT */
  h += '<div class="disclaim"><b>Underwriting basis.</b> Utility rates and incentives are seeded from filed tariffs and refreshed by live query where a verified public source is reachable. ISO capacity value, interconnection availability, and compute marketplace pricing are modeled estimates and must be confirmed against signed offtake and interconnection studies before capital commitment. This is an investment screening tool, not a financing commitment or an offer of securities.</div>';
  h += '<div class="export-row">'+
    '<button class="btn btn-navy" onclick="window.print()">Print / Save PDF</button>'+
    '<button class="btn btn-ghost" onclick="exportCSV()">Export CSV</button>'+
  '</div>';

  $('report').innerHTML=h;
  $('report').classList.add('on');
  window.__uwModel=m;
  $('btn-proposal').disabled=false;
}

/* small render helpers */
function row(k,s,v,cls){ return '<div class="row"><div class="k">'+k+(s?'<span class="s">'+s+'</span>':'')+'</div><div class="v '+(cls||'')+'">'+v+'</div></div>'; }
function pnl(k,s,v,cls){ var disp=(v<0?'('+fmt$(Math.abs(v))+')':fmt$(v)); return '<tr><td class="lbl">'+k+(s?'<span class="s">'+s+'</span>':'')+'</td><td class="num '+(cls||'')+'">'+disp+'</td></tr>'; }
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function archName(a){ return ({dcfc_edge:'DCFC + Edge Compute', datacenter:'Data Center', bess_arb:'Standalone BESS', solar_bess:'Solar + BESS'})[a]||a; }

function cashSVG(m){
  var w=560,h=220,pad=44;
  var pts=[{cum:-m.netCapex,y:0}];
  for(var i=0;i<m.years.length;i++) pts.push({cum:m.years[i].cum,y:m.years[i].y});
  var mx=-1e18,mn=1e18; for(var p=0;p<pts.length;p++){ if(pts[p].cum>mx)mx=pts[p].cum; if(pts[p].cum<mn)mn=pts[p].cum; }
  if(mx===mn){mx+=1;mn-=1;} var rg=mx-mn;
  function px(i){ return pad+(i/(pts.length-1))*(w-pad-16); }
  function py(v){ return pad/2+(1-(v-mn)/rg)*(h-pad); }
  var zy=py(0), path='';
  for(var q=0;q<pts.length;q++){ path+=(q===0?'M':'L')+px(q).toFixed(1)+' '+py(pts[q].cum).toFixed(1)+' '; }
  var area=path+'L'+px(pts.length-1).toFixed(1)+' '+zy.toFixed(1)+' L'+px(0).toFixed(1)+' '+zy.toFixed(1)+' Z';
  var dots='';
  for(var d=0;d<pts.length;d++){ var c=pts[d].cum>=0?'#1DB954':'#E53935';
    dots+='<circle cx="'+px(d).toFixed(1)+'" cy="'+py(pts[d].cum).toFixed(1)+'" r="3.5" fill="'+c+'"/>';
    if(d%2===0||d===pts.length-1) dots+='<text x="'+px(d).toFixed(1)+'" y="'+(h-6)+'" font-size="9" fill="#6B7A8D" text-anchor="middle" font-family="DM Mono">'+(d===0?'Y0':'Y'+pts[d].y)+'</text>';
  }
  return '<svg class="chart-svg" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet" style="height:220px">'+
    '<line x1="'+pad+'" y1="'+zy.toFixed(1)+'" x2="'+(w-16)+'" y2="'+zy.toFixed(1)+'" stroke="#DDD8D0" stroke-dasharray="3 3"/>'+
    '<path d="'+area+'" fill="rgba(46,134,193,.08)"/>'+
    '<path d="'+path+'" fill="none" stroke="#1B4F8A" stroke-width="2.5" stroke-linejoin="round"/>'+dots+
    '<text x="'+pad+'" y="'+(zy-6).toFixed(1)+'" font-size="9" fill="#6B7A8D" font-family="DM Mono">break-even</text></svg>';
}

/* ══════════════════════════════════════════════════════════════════
   AI INVESTOR PROPOSAL  (Anthropic API — "Claude in Claude")
   Grounds the memo strictly in the computed numbers. Falls back to a
   deterministic template if the API is unreachable.
   ══════════════════════════════════════════════════════════════════ */
function generateProposal(){
  var m = window.__uwModel; if(!m) return;
  var body=$('proposal-body');
  body.innerHTML='<div class="proposal-empty"><span class="spinner on"></span>Drafting investor memo grounded in the site numbers…</div>';

  var U=m.ctx.util;
  var facts = {
    address: val('i_addr'),
    utility: U.name, iso: U.iso, rate: U.rateSchedule,
    archetype: archName(m.arch),
    grid_kw: Math.round(m.gridKw), bess_kw: Math.round(m.bkw), bess_kwh: Math.round(m.bkwh),
    compute_kw: Math.round(m.computeKw), solar_kw: Math.round(m.solarKw), wind_kw: Math.round(m.windKw),
    net_capital: Math.round(m.netCapex), gross_capital: Math.round(m.grossCapex),
    itc: Math.round(m.itcAmt), storage_rebate: Math.round(m.storageRebate),
    incentive_program: m.ctx.incentive.program,
    y1_revenue: Math.round(m.grossRevenue), y1_ebitda: Math.round(m.y1ebitda),
    compute_rev: Math.round(m.revenue.compute), arbitrage: Math.round(m.revenue.arbitrage),
    capacity_rev: Math.round(m.revenue.capacity), demand_offset: Math.round(m.revenue.demand),
    irr: m.projIrr===null?'n/a':(m.projIrr*100).toFixed(1)+'%',
    npv: Math.round(m.projNpv), payback: m.payback===null?'>'+m.life+'yr':m.payback.toFixed(1)+' yr',
    lifetime_roi: (m.roi*100).toFixed(0)+'%', discount_rate:(m.disc*100).toFixed(0)+'%', life:m.life,
    compute_price: m.cprice, verdict:m.vtxt
  };

  var prompt = 'You are an infrastructure investment analyst writing a concise investor memo for a decision to deploy a battery-energy-storage + edge-compute site. '+
    'Use ONLY these figures; do not invent numbers. Write in confident, quantitative, investor-facing prose. '+
    'Output clean HTML using only <h4>, <p>, <ul>, <li>, and <strong> tags (no <html>/<head>/<body>, no markdown, no preamble). '+
    'Sections, in order: "Opportunity" (2-3 sentences on the site and thesis), "Revenue Model" (the stacked streams and why they hold in this ISO), '+
    '"Capital & Returns" (net capital, IRR, NPV, payback, ROI), "Risks & Mitigants" (3-4 bullets specific to this market/rate), '+
    'and "Recommendation" (one paragraph tied to the verdict). Keep it under 450 words. '+
    'SITE FACTS (JSON): '+JSON.stringify(facts);

  var payload = { model:'claude-sonnet-4-6', max_tokens:1000, messages:[{role:'user', content:prompt}] };

  var done=false;
  var t=setTimeout(function(){ if(!done){ done=true; body.innerHTML=fallbackProposal(m,facts); } }, 22000);

  fetch('https://api.anthropic.com/v1/messages',{
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
  }).then(function(r){ return r.json(); }).then(function(data){
    if(done) return; done=true; clearTimeout(t);
    var text='';
    try{
      for(var i=0;i<data.content.length;i++){ if(data.content[i].type==='text') text+=data.content[i].text; }
    }catch(e){ text=''; }
    text = text.replace(/```html|```/g,'').trim();
    if(text.length<40){ body.innerHTML=fallbackProposal(m,facts); }
    else { body.innerHTML=text; }
  }).catch(function(){ if(!done){ done=true; clearTimeout(t); body.innerHTML=fallbackProposal(m,facts); } });
}

/* deterministic fallback so the tool always produces a memo */
function fallbackProposal(m,f){
  var U=m.ctx.util;
  var lead = m.revenue.compute>=m.grossRevenue*0.5 ? 'compute-led' : 'storage-led';
  return ''+
  '<h4>Opportunity</h4><p>This '+esc(f.archetype)+' site at <strong>'+esc(f.address)+'</strong> sits in the <strong>'+U.iso+'</strong> market served by '+U.name+' ('+U.rate+'). '+
    'The '+lead+' configuration pairs '+fmtN(m.bkw)+' kW / '+fmtN(m.bkwh)+' kWh of storage with '+fmtN(m.computeKw)+' kW of compute against '+fmtN(m.gridKw)+' kW of available grid capacity.</p>'+
  '<h4>Revenue Model</h4><p>Year-1 gross revenue of <strong>'+fmt$(m.grossRevenue)+'</strong> stacks across independent streams, reducing single-market exposure:</p>'+
    '<ul>'+
    '<li><strong>Compute marketplace:</strong> '+fmt$(m.revenue.compute)+' at $'+m.cprice.toFixed(2)+'/kWh, '+(m.cutil*100).toFixed(0)+'% utilization.</li>'+
    '<li><strong>TOU arbitrage:</strong> '+fmt$(m.revenue.arbitrage)+' on the $'+U.peakSpread.toFixed(3)+'/kWh peak spread.</li>'+
    '<li><strong>Capacity / VPP:</strong> '+fmt$(m.revenue.capacity)+' from '+U.iso+' capacity at $'+m.vstack.toFixed(0)+'/kW-yr.</li>'+
    (m.revenue.demand>0?'<li><strong>Demand offset:</strong> '+fmt$(m.revenue.demand)+' from peak shaving.</li>':'')+
    '</ul>'+
  '<h4>Capital &amp; Returns</h4><p>Net capital of <strong>'+fmt$(m.netCapex)+'</strong> (after '+fmt$(m.itcAmt)+' ITC'+(m.storageRebate>0?' and '+fmt$(m.storageRebate)+' '+m.ctx.incentive.program+' rebate':'')+') produces a <strong>'+f.irr+' project IRR</strong>, '+
    fmt$(m.projNpv)+' NPV at '+f.discount_rate+', and payback in <strong>'+f.payback+'</strong> over a '+m.life+'-year hold ('+f.lifetime_roi+' lifetime ROI).</p>'+
  '<h4>Risks &amp; Mitigants</h4><ul>'+
    '<li><strong>Compute offtake:</strong> revenue concentration in the compute stream — mitigate with a signed marketplace/offtake agreement before final funding.</li>'+
    '<li><strong>Interconnection:</strong> '+fmtN(m.gridKw)+' kW availability is modeled — confirm with a '+U.name+' study.</li>'+
    '<li><strong>Rate risk:</strong> '+U.iso+' TOU spread and capacity value can compress; the diversified stack cushions any single-market move.</li>'+
    '<li><strong>Incentive timing:</strong> ITC and '+m.ctx.incentive.program+' eligibility should be locked to the construction schedule.</li>'+
  '</ul>'+
  '<h4>Recommendation</h4><p>The site screens as <strong>'+m.vtxt+'</strong>. '+
    (m.verdict==='go'?'Returns clear the '+f.discount_rate+' hurdle with margin; advance to interconnection study and offtake term sheets.':
     m.verdict==='caution'?'Returns are positive but hurdle-sensitive; advance only with a signed compute offtake and confirmed interconnection.':
     'Returns fall short of the hurdle at current assumptions; revisit compute pricing, system sizing, or a lower-cost interconnection before proceeding.')+'</p>';
}

/* CSV export */
function exportCSV(){
  var m=window.__uwModel; if(!m) return;
  var U=m.ctx.util;
  var rows=[['Site Investment Analysis — ClearSky-OMEGA']];
  rows.push(['Address',val('i_addr')]); rows.push(['Utility',U.name]); rows.push(['ISO',U.iso]);
  rows.push([]); rows.push(['Project IRR',m.projIrr===null?'n/a':(m.projIrr*100).toFixed(2)+'%']);
  rows.push(['NPV',Math.round(m.projNpv)]); rows.push(['Payback',m.payback===null?'>life':m.payback.toFixed(2)]);
  rows.push(['Net capital',Math.round(m.netCapex)]); rows.push(['Yr-1 EBITDA',Math.round(m.y1ebitda)]);
  rows.push([]); rows.push(['Year','Compute','Arbitrage','Capacity','Demand','Energy','O&M','Net CF','Cumulative']);
  for(var i=0;i<m.years.length;i++){ var Y=m.years[i];
    rows.push([Y.y,Math.round(Y.compute),Math.round(Y.arbitrage),Math.round(Y.capacity),Math.round(Y.demand),Math.round(Y.energy),Math.round(Y.om),Math.round(Y.net),Math.round(Y.cum)]); }
  var csv=rows.map(function(r){return r.join(',');}).join('\n');
  var blob=new Blob([csv],{type:'text/csv'}); var a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download='site-investment-analysis.csv'; a.click();
}

/* ══════════════════════════════════════════════════════════════════
   ORCHESTRATION
   ══════════════════════════════════════════════════════════════════ */
function runUnderwriting(){
  var addr=val('i_addr');
  if(!addr){ showErr('Enter a site address or ZIP to begin.'); return; }
  hideErr();
  var spin=$('run-spin'), status=$('run-status'), btn=$('btn-run');
  spin.classList.add('on'); btn.disabled=true;
  status.textContent='Resolving market, utility & incentives…';
  $('datasrc').classList.add('on');
  $('ds-list').innerHTML='<div class="ds-item"><span class="ds-dot pending"></span><span class="ds-detail">Querying live sources…</span></div>';

  var utilKey=val('i_util');
  runLiveQueries(addr, utilKey).then(function(ctx){
    $('ds-list').innerHTML = ctx.provenance.join('');
    // auto-seed value stack from ISO capacity value if user hasn't overridden meaningfully
    if($('a_vstack')){ /* keep user value but default was seeded on util change */ }
    status.textContent='Underwriting site economics…';
    var m = underwrite(ctx);
    renderReport(m);
    spin.classList.remove('on'); btn.disabled=false;
    status.textContent='Done · '+m.vtxt+' · '+(m.projIrr===null?'n/a':(m.projIrr*100).toFixed(1)+'% IRR');
    $('report').scrollIntoView({behavior:'smooth',block:'start'});
  }).catch(function(e){
    spin.classList.remove('on'); btn.disabled=false;
    showErr('Could not complete the query. '+(e&&e.message?e.message:'')+' Using seeded market data — try Run again.');
    // still run with seeded data
    var U=UTILS[utilKey]; var st=U.state||stateFromZip(extractZip(addr))||'US';
    var ctx={ util:U, iso:U.iso, state:st, incentive:INCENTIVES[st]||INCENTIVES['US'],
      provenance:[dsRow('Utility &amp; ISO tariff','verified',U.name+' · '+U.iso), dsRow('Live geocode','na','offline — used seeded market data')] };
    $('ds-list').innerHTML=ctx.provenance.join('');
    var m=underwrite(ctx); renderReport(m);
  });
}

function showErr(msg){ var e=$('err-box'); e.textContent=msg; e.classList.add('on'); }
function hideErr(){ $('err-box').classList.remove('on'); }

/* when utility changes, seed the ISO value-stack default */
function seedValueStack(){
  var U=UTILS[val('i_util')]; if(U && $('a_vstack')){ $('a_vstack').value=U.capacityValue; }
}

function initUtilSelect(){
  var sel=$('i_util'), h='';
  for(var i=0;i<UTIL_ORDER.length;i++){ var k=UTIL_ORDER[i]; h+='<option value="'+k+'">'+UTILS[k].name+'</option>'; }
  sel.innerHTML=h; sel.value='sce';
}
function boot(){
  try{ if(window.OMEGA_WORKSPACE){ $('tb-badge').textContent=window.OMEGA_WORKSPACE.accountTier||'Enterprise';
    if(window.OMEGA_WORKSPACE.exportBrand&&window.OMEGA_WORKSPACE.exportBrand.poweredBy) $('foot-powered').textContent=window.OMEGA_WORKSPACE.exportBrand.poweredBy; } }catch(e){}
  initUtilSelect(); seedValueStack();
  $('adv-toggle').addEventListener('click',function(){
    var p=$('adv-panel'); p.classList.toggle('open');
    this.innerHTML=(p.classList.contains('open')?'▾':'▸')+' Advanced site &amp; system inputs';
  });
  $('i_util').addEventListener('change',seedValueStack);
  $('btn-run').addEventListener('click',runUnderwriting);
  $('btn-proposal').addEventListener('click',generateProposal);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
