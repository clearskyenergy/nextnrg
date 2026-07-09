/* ═══════════════════════════════════════════════════════════════════════
   DCFC BESS Pro Forma — calculation engine (ES5)
   © 2025 ClearSky Energy Solutions LLC · Author: Tommy Gilmer
   Utility rates seeded from real filed tariffs. TOU-EV-8 values are the
   Total Delivery + Generation (UG) energy charges from Cal. P.U.C.
   Sheet 91206-E (effective Jun 1, 2026), summer/winter blended.
   ═══════════════════════════════════════════════════════════════════════ */

/* ---- Rate library. energy = blended $/kWh across TOU periods.
   peak/offpeak used for arbitrage spread. demandCharge $/kW-month. ---- */
var RATES = {
  'sce_touev8': {
    name: 'SCE TOU-EV-8 (Demand-Metered EV)',
    hint: 'Southern California Edison · separately-metered EV charging · no demand charge (phased to $0).',
    // Total delivery (0.32364 on/mid) + generation UG. Summer on-peak worst case.
    onPeak: 0.32364 + 0.35187,      // summer on-peak delivery + gen UG = 0.67551
    midPeak: 0.32364 + 0.09989,     // 0.42353
    offPeak: 0.16117 + 0.07728,     // 0.23845
    superOff: 0.08631 + 0.03907,    // 0.12538
    blended: 0.34,                  // realistic annual blended $/kWh
    demandCharge: 0,                // TOU-EV-8: no demand charge (SC 5a)
    fixedMonthly: 268.43 - 42.39,   // customer charge less EV submeter credit
    note: 'Demand charge is $0 under TOU-EV-8 — value comes from TOU energy arbitrage, not demand offset.'
  },
  'sce_touev9': {
    name: 'SCE TOU-EV-9 (>500 kW EV)',
    hint: 'For sites expected above 500 kW max demand. Demand charge applies at larger scale.',
    onPeak: 0.29 + 0.30, midPeak: 0.29 + 0.10, offPeak: 0.14 + 0.07, superOff: 0.08 + 0.04,
    blended: 0.31, demandCharge: 22.00, fixedMonthly: 480.00,
    note: 'Larger sites carry a real demand charge — battery peak-shaving directly offsets it.'
  },
  'ladwp_ev': {
    name: 'LADWP EV / A-2 General Service',
    hint: 'Los Angeles Dept. of Water & Power · commercial EV / general service, demand-metered.',
    onPeak: 0.28, midPeak: 0.20, offPeak: 0.12, superOff: 0.10,
    blended: 0.20, demandCharge: 18.00, fixedMonthly: 120.00,
    note: 'Municipal utility; demand charge present. Confirm current A-2 schedule at billing.'
  },
  'pge_bev2': {
    name: 'PG&E BEV-2 (>100 kW EV)',
    hint: 'Pacific Gas & Electric · commercial EV rate, subscription demand instead of $/kW.',
    onPeak: 0.42, midPeak: 0.34, offPeak: 0.24, superOff: 0.18,
    blended: 0.32, demandCharge: 0, fixedMonthly: 95.56,
    note: 'Uses monthly subscription blocks in lieu of demand charge; high TOU spread favors storage.'
  },
  'sdge_ev': {
    name: 'SDG&E EV-HP (High Power EV)',
    hint: 'San Diego Gas & Electric · high-power public charging rate.',
    onPeak: 0.44, midPeak: 0.33, offPeak: 0.22, superOff: 0.15,
    blended: 0.31, demandCharge: 0, fixedMonthly: 82.00,
    note: 'Very wide peak/off-peak spread — one of the strongest CA markets for DCFC+BESS arbitrage.'
  },
  'generic': {
    name: 'Generic Commercial TOU (custom)',
    hint: 'Typical U.S. commercial demand-metered rate. Edit peak/off-peak spread to your market.',
    onPeak: 0.24, midPeak: 0.16, offPeak: 0.10, superOff: 0.08,
    blended: 0.14, demandCharge: 15.00, fixedMonthly: 60.00,
    note: 'Adjust to your ISO / utility. Demand charge present in most non-EV commercial tariffs.'
  }
};
var RATE_ORDER = ['sce_touev8','sce_touev9','ladwp_ev','pge_bev2','sdge_ev','generic'];

/* ---- helpers ---- */
function $(id){ return document.getElementById(id); }
function num(id){ var v=parseFloat($(id).value); return isNaN(v)?0:v; }
function fmt$(v){ var n=Math.round(v); return '$'+n.toLocaleString('en-US'); }
function fmt$k(v){
  if(Math.abs(v)>=1e6) return '$'+(v/1e6).toFixed(2)+'M';
  if(Math.abs(v)>=1e3) return '$'+(v/1e3).toFixed(0)+'k';
  return '$'+Math.round(v);
}
function fmtPct(v){ return v.toFixed(1)+'%'; }
function fmtN(v){ return Math.round(v).toLocaleString('en-US'); }

/* IRR via bisection on NPV */
function irr(cashflows){
  function npvAt(r){ var s=0; for(var i=0;i<cashflows.length;i++){ s+=cashflows[i]/Math.pow(1+r,i);} return s; }
  var lo=-0.9, hi=3.0, mid=0;
  if(npvAt(lo)*npvAt(hi)>0) return null; // no sign change
  for(var k=0;k<200;k++){ mid=(lo+hi)/2; var v=npvAt(mid); if(Math.abs(v)<1) break; if(npvAt(lo)*v<0) hi=mid; else lo=mid; }
  return mid;
}
function npv(rate,cashflows){ var s=0; for(var i=0;i<cashflows.length;i++){ s+=cashflows[i]/Math.pow(1+rate,i);} return s; }

/* ══════════ CORE MODEL ══════════ */
function computeModel(){
  var rateKey = $('i_rate').value;
  var R = RATES[rateKey];

  var kwh = num('i_kwh');            // annual throughput kWh
  var peak = num('i_peak');          // site peak kW
  var retail = num('i_retail');      // $/kWh charged to driver
  var bkw = num('i_bkw');            // battery kW
  var bkwh = num('i_bkwh');          // battery kWh
  var rte = num('i_rte')/100;
  var deg = num('i_deg')/100;
  var capexPerKwh = num('i_capex');
  var itc = num('i_itc')/100;
  var rebate = num('i_rebate');      // $/kWh
  var omPerKw = num('i_om');
  var disc = num('i_disc')/100;
  var life = Math.max(1, Math.round(num('i_life')));
  var vppPerKw = num('i_vpp');
  var growth = num('i_growth')/100;

  /* ---- CAPEX ---- */
  var grossCapex = bkwh * capexPerKwh;
  var itcAmt = grossCapex * itc;
  var rebateAmt = bkwh * rebate;
  var netCapex = grossCapex - itcAmt - rebateAmt;

  /* ---- Charging gross margin (energy the site resells) ---- */
  var wholesaleBlended = R.blended;          // $/kWh cost to buy from grid
  var chargingMargin_y1 = kwh * (retail - wholesaleBlended);

  /* ---- BESS value stack (year 1) ----
     1) Demand-charge offset: battery shaves up to bkw of peak. */
  var shavedKw = Math.min(bkw, peak);
  var demandSaving = shavedKw * R.demandCharge * 12;

  /* 2) TOU energy arbitrage: cycle battery once/day, buy super-off/off, avoid on-peak.
        Effective usable energy per cycle limited by kWh and RTE. */
  var cyclesPerYear = 365;
  var usableKwh = bkwh * 0.90;               // usable DoD
  var spread = R.onPeak - R.superOff;        // best-case $/kWh spread
  // realistic capture ~ 65% of theoretical spread after RTE & imperfect timing
  var arbEffKwh = usableKwh * rte;
  var arbitrage = cyclesPerYear * arbEffKwh * spread * 0.65;

  /* 3) VPP / capacity */
  var vppRev = bkw * vppPerKw;

  var stackY1 = demandSaving + arbitrage + vppRev;

  /* ---- OPEX ---- */
  var omCost = bkw * omPerKw;

  /* ---- multi-year cashflows ---- */
  var years = [];
  var cashflows = [-netCapex];
  var cumUndisc = -netCapex;
  var paybackYr = null;
  for(var y=1; y<=life; y++){
    var utilFactor = Math.pow(1+growth, y-1);
    var degFactor = Math.pow(1-deg, y-1);
    var charging = chargingMargin_y1 * utilFactor;
    var demand = demandSaving * degFactor;
    var arb = arbitrage * degFactor * utilFactor; // more sessions -> more cycles opportunity, capped
    if(arb > cyclesPerYear*usableKwh*rte*spread) arb = cyclesPerYear*usableKwh*rte*spread;
    var vpp = vppRev * degFactor;
    var om = omCost * Math.pow(1.02, y-1); // O&M inflates 2%
    var net = charging + demand + arb + vpp - om;
    cashflows.push(net);
    var prevCum = cumUndisc;
    cumUndisc += net;
    if(paybackYr===null && cumUndisc>=0){
      paybackYr = (y-1) + (-prevCum)/net; // linear interp within year
    }
    years.push({ y:y, charging:charging, demand:demand, arb:arb, vpp:vpp, om:om, net:net, cum:cumUndisc });
  }

  var projIrr = irr(cashflows);
  var projNpv = npv(disc, cashflows);
  var totalNet = 0; for(var i=1;i<cashflows.length;i++) totalNet+=cashflows[i];
  var roi = totalNet / netCapex;

  /* verdict logic */
  var verdict='caution', verdictTxt='Marginal';
  if(projIrr!==null){
    if(projIrr >= disc + 0.06 && paybackYr!==null && paybackYr<=life*0.7){ verdict='go'; verdictTxt='Strong Return'; }
    else if(projIrr < disc){ verdict='no'; verdictTxt='Below Hurdle'; }
    else { verdict='caution'; verdictTxt='Marginal'; }
  } else { verdict='no'; verdictTxt='No Positive Return'; }

  return {
    R:R, grossCapex:grossCapex, itcAmt:itcAmt, rebateAmt:rebateAmt, netCapex:netCapex,
    chargingMargin_y1:chargingMargin_y1, demandSaving:demandSaving, arbitrage:arbitrage, vppRev:vppRev,
    stackY1:stackY1, omCost:omCost, shavedKw:shavedKw, spread:spread,
    years:years, cashflows:cashflows, projIrr:projIrr, projNpv:projNpv,
    totalNet:totalNet, roi:roi, paybackYr:paybackYr, verdict:verdict, verdictTxt:verdictTxt,
    life:life, disc:disc, retail:retail, wholesaleBlended:wholesaleBlended, kwh:kwh, bkw:bkw, bkwh:bkwh
  };
}

/* ══════════ RENDER ══════════ */
function render(){
  var m = computeModel();
  var R = m.R;

  // rate hint + summary
  $('rate_hint').textContent = R.hint;
  $('rate_summary').innerHTML = '<b>'+R.name+'</b><br>'+R.note+
    '<br><br>Blended energy: <b>'+ ('$'+R.blended.toFixed(3)) +'/kWh</b> · '+
    'Peak/off spread: <b>'+ ('$'+(R.onPeak-R.superOff).toFixed(3)) +'/kWh</b> · '+
    'Demand charge: <b>'+ ('$'+R.demandCharge.toFixed(2)) +'/kW-mo</b>';

  var revStackTotal = m.chargingMargin_y1 + m.stackY1;
  var y1net = m.years.length? m.years[0].net : 0;

  var html = '';

  /* ── VERDICT ── */
  var flagCls = m.verdict==='go'?'go':(m.verdict==='no'?'no':'caution');
  html += '<div class="verdict">'+
    '<div class="verdict-top">'+
      '<div class="verdict-label">Investment Verdict</div>'+
      '<div class="verdict-flag '+flagCls+'">'+m.verdictTxt+'</div>'+
    '</div>'+
    '<div class="verdict-metrics">'+
      '<div class="vm"><div class="vm-val '+(m.projIrr>=m.disc?'pos':'neg')+'">'+(m.projIrr===null?'—':(m.projIrr*100).toFixed(1))+'<span class="vm-unit">%</span></div><div class="vm-label">Project IRR</div></div>'+
      '<div class="vm"><div class="vm-val '+(m.projNpv>=0?'pos':'neg')+'">'+fmt$k(m.projNpv)+'</div><div class="vm-label">NPV @ '+(m.disc*100).toFixed(0)+'%</div></div>'+
      '<div class="vm"><div class="vm-val">'+(m.paybackYr===null?'>'+m.life:m.paybackYr.toFixed(1))+'<span class="vm-unit">yr</span></div><div class="vm-label">Payback</div></div>'+
      '<div class="vm"><div class="vm-val '+(m.roi>=0?'pos':'neg')+'">'+(m.roi*100).toFixed(0)+'<span class="vm-unit">%</span></div><div class="vm-label">Lifetime ROI</div></div>'+
    '</div>'+
  '</div>';

  /* ── KPI ROW ── */
  html += '<div class="kpi-grid">'+
    '<div class="kpi blue"><div class="kpi-label">Net Investment</div><div class="kpi-val">'+fmt$k(m.netCapex)+'</div><div class="kpi-foot">after ITC &amp; rebate</div></div>'+
    '<div class="kpi green"><div class="kpi-label">Yr-1 Net Cash Flow</div><div class="kpi-val">'+fmt$k(y1net)+'</div><div class="kpi-foot">margin + stack − O&amp;M</div></div>'+
    '<div class="kpi"><div class="kpi-label">Yr-1 Revenue Stack</div><div class="kpi-val">'+fmt$k(revStackTotal)+'</div><div class="kpi-foot">all streams gross</div></div>'+
    '<div class="kpi"><div class="kpi-label">System Size</div><div class="kpi-val">'+fmtN(m.bkw)+'<span class="unit">kW</span></div><div class="kpi-foot">'+fmtN(m.bkwh)+' kWh · '+(m.bkwh/m.bkw).toFixed(1)+'h</div></div>'+
  '</div>';

  /* ── REVENUE STACK ── */
  var segs = [
    {k:'Charging margin', v:m.chargingMargin_y1, c:'#1B4F8A'},
    {k:'Demand offset', v:m.demandSaving, c:'#2E86C1'},
    {k:'TOU arbitrage', v:m.arbitrage, c:'#C9A84C'},
    {k:'VPP / capacity', v:m.vppRev, c:'#1DB954'}
  ];
  var segTotal=0; for(var s=0;s<segs.length;s++) segTotal+=segs[s].v;
  var barHtml='', legHtml='';
  for(var s2=0;s2<segs.length;s2++){
    var pct = segTotal>0? (segs[s2].v/segTotal*100):0;
    if(pct>0){
      barHtml += '<div class="seg" style="width:'+pct.toFixed(1)+'%;background:'+segs[s2].c+'">'+(pct>=9?pct.toFixed(0)+'%':'')+'</div>';
    }
    legHtml += '<div class="li"><span class="dot" style="background:'+segs[s2].c+'"></span>'+segs[s2].k+' · <b>'+fmt$k(segs[s2].v)+'</b></div>';
  }
  html += '<div class="rcard"><div class="rcard-head"><div><h3>Year-1 Revenue Stack</h3><div class="sub">Where the money comes from, before O&amp;M</div></div></div>'+
    '<div class="rcard-body">'+
      '<div class="stackbar">'+barHtml+'</div>'+
      '<div class="stack-legend">'+legHtml+'</div>'+
      '<table class="ftable" style="margin-top:18px">'+
        '<tr><td class="lbl">Charging gross margin<span class="s">'+fmtN(m.kwh)+' kWh × ($'+m.retail.toFixed(2)+' retail − $'+m.wholesaleBlended.toFixed(3)+' cost)</span></td><td class="num pos">'+fmt$(m.chargingMargin_y1)+'</td></tr>'+
        '<tr><td class="lbl">Demand-charge offset<span class="s">'+fmtN(m.shavedKw)+' kW shaved × $'+R.demandCharge.toFixed(2)+'/kW-mo × 12</span></td><td class="num pos">'+fmt$(m.demandSaving)+'</td></tr>'+
        '<tr><td class="lbl">TOU energy arbitrage<span class="s">365 cycles × usable kWh × $'+m.spread.toFixed(3)+' spread (65% capture)</span></td><td class="num pos">'+fmt$(m.arbitrage)+'</td></tr>'+
        '<tr><td class="lbl">VPP / capacity payments<span class="s">'+fmtN(m.bkw)+' kW × $'+num('i_vpp').toFixed(0)+'/kW-yr</span></td><td class="num pos">'+fmt$(m.vppRev)+'</td></tr>'+
        '<tr><td class="lbl">O&amp;M<span class="s">'+fmtN(m.bkw)+' kW × $'+num('i_om').toFixed(0)+'/kW-yr</span></td><td class="num neg">('+fmt$(m.omCost)+')</td></tr>'+
        '<tr class="total"><td class="lbl">Year-1 net operating cash flow</td><td class="num">'+fmt$(y1net)+'</td></tr>'+
      '</table>'+
    '</div></div>';

  /* ── CAPITAL STACK ── */
  html += '<div class="rcard"><div class="rcard-head"><div><h3>Capital Requirement</h3><div class="sub">Gross install less incentives</div></div></div>'+
    '<div class="rcard-body"><table class="ftable">'+
      '<tr><td class="lbl">Gross installed cost<span class="s">'+fmtN(m.bkwh)+' kWh × $'+num('i_capex').toFixed(0)+'/kWh</span></td><td class="num">'+fmt$(m.grossCapex)+'</td></tr>'+
      '<tr><td class="lbl">Federal ITC<span class="s">'+num('i_itc').toFixed(0)+'% of gross</span></td><td class="num neg">('+fmt$(m.itcAmt)+')</td></tr>'+
      '<tr><td class="lbl">State / utility rebate<span class="s">$'+num('i_rebate').toFixed(0)+'/kWh</span></td><td class="num neg">('+fmt$(m.rebateAmt)+')</td></tr>'+
      '<tr class="total"><td class="lbl">Net investment required</td><td class="num">'+fmt$(m.netCapex)+'</td></tr>'+
    '</table></div></div>';

  /* ── CASHFLOW CHART ── */
  html += '<div class="rcard"><div class="rcard-head"><div><h3>Cumulative Cash Flow</h3><div class="sub">Break-even at year '+(m.paybackYr===null?'—':m.paybackYr.toFixed(1))+'</div></div></div>'+
    '<div class="rcard-body">'+ cashflowSVG(m) +'</div></div>';

  /* ── YEAR-BY-YEAR ── */
  var rows='';
  for(var yi=0; yi<m.years.length; yi++){
    var Y=m.years[yi];
    rows += '<tr><td>Year '+Y.y+'</td>'+
      '<td>'+fmt$k(Y.charging)+'</td>'+
      '<td>'+fmt$k(Y.demand+Y.arb+Y.vpp)+'</td>'+
      '<td class="neg">('+fmt$k(Y.om)+')</td>'+
      '<td class="'+(Y.net>=0?'pos':'neg')+'">'+fmt$k(Y.net)+'</td>'+
      '<td class="'+(Y.cum>=0?'pos':'neg')+'">'+fmt$k(Y.cum)+'</td></tr>';
  }
  html += '<div class="rcard"><div class="rcard-head"><div><h3>10-Year Cash Flow Detail</h3><div class="sub">Charging margin grows '+num('i_growth').toFixed(0)+'%/yr; battery degrades '+num('i_deg').toFixed(1)+'%/yr</div></div></div>'+
    '<div class="rcard-body ytable-wrap"><table class="ytable">'+
      '<thead><tr><th>Period</th><th>Charging</th><th>BESS stack</th><th>O&amp;M</th><th>Net CF</th><th>Cumulative</th></tr></thead>'+
      '<tbody>'+rows+'</tbody></table></div></div>';

  /* ── ASSUMPTIONS ── */
  html += '<div class="rcard"><div class="rcard-head"><div><h3>Key Assumptions</h3></div></div>'+
    '<div class="rcard-body assump">'+
    'This sheet models a standalone BESS co-located with an existing DCFC site. Core drivers:'+
    '<ul>'+
      '<li><b>Charging margin</b> is the spread between the retail price drivers pay and the utility energy cost — the site\u2019s primary business, independent of the battery.</li>'+
      '<li><b>Demand-charge offset</b> assumes the battery reliably shaves '+fmtN(m.shavedKw)+' kW of the site\u2019s peak. Under '+R.name+', the demand charge is $'+R.demandCharge.toFixed(2)+'/kW-mo.</li>'+
      '<li><b>TOU arbitrage</b> assumes one full cycle/day at '+num('i_rte').toFixed(0)+'% round-trip efficiency, capturing 65% of the theoretical $'+m.spread.toFixed(3)+'/kWh peak-to-super-off-peak spread.</li>'+
      '<li><b>Returns</b> use net cash flows discounted at '+(m.disc*100).toFixed(0)+'% over '+m.life+' years. IRR solved on the full cashflow series including the initial outlay.</li>'+
    '</ul>'+
    '</div></div>';

  /* ── EXPORT ── */
  html += '<div class="export-row">'+
    '<button class="btn btn-primary" onclick="window.print()">Print / Save PDF</button>'+
    '<button class="btn btn-ghost" onclick="exportCSV()">Export CSV</button>'+
  '</div>';

  $('results').innerHTML = html;
  window.__lastModel = m;
}

/* cumulative-cashflow SVG line chart */
function cashflowSVG(m){
  var w=640, h=220, pad=44;
  var pts=[]; pts.push({y:0, cum:-m.netCapex});
  for(var i=0;i<m.years.length;i++) pts.push({y:m.years[i].y, cum:m.years[i].cum});
  var maxV=-Infinity, minV=Infinity;
  for(var p=0;p<pts.length;p++){ if(pts[p].cum>maxV)maxV=pts[p].cum; if(pts[p].cum<minV)minV=pts[p].cum; }
  if(maxV===minV){ maxV+=1; minV-=1; }
  var range=maxV-minV;
  function px(i){ return pad + (i/(pts.length-1))*(w-pad-16); }
  function py(v){ return pad/2 + (1-(v-minV)/range)*(h-pad); }
  var zeroY = py(0);
  var path='', area='';
  for(var q=0;q<pts.length;q++){
    var x=px(q), y=py(pts[q].cum);
    path += (q===0?'M':'L')+x.toFixed(1)+' '+y.toFixed(1)+' ';
  }
  area = path + 'L'+px(pts.length-1).toFixed(1)+' '+zeroY.toFixed(1)+' L'+px(0).toFixed(1)+' '+zeroY.toFixed(1)+' Z';
  // dots + labels
  var dots='';
  for(var d=0;d<pts.length;d++){
    var col = pts[d].cum>=0?'#1DB954':'#E53935';
    dots += '<circle cx="'+px(d).toFixed(1)+'" cy="'+py(pts[d].cum).toFixed(1)+'" r="3.5" fill="'+col+'"/>';
    if(d%2===0 || d===pts.length-1){
      dots += '<text x="'+px(d).toFixed(1)+'" y="'+(h-6)+'" font-size="9" fill="#6B7A8D" text-anchor="middle" font-family="DM Mono">'+(d===0?'Y0':'Y'+pts[d].y)+'</text>';
    }
  }
  return '<svg class="cf-chart" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet">'+
    '<line x1="'+pad+'" y1="'+zeroY.toFixed(1)+'" x2="'+(w-16)+'" y2="'+zeroY.toFixed(1)+'" stroke="#DDD8D0" stroke-width="1" stroke-dasharray="3 3"/>'+
    '<path d="'+area+'" fill="rgba(46,134,193,.08)"/>'+
    '<path d="'+path+'" fill="none" stroke="#1B4F8A" stroke-width="2.5" stroke-linejoin="round"/>'+
    dots+
    '<text x="'+pad+'" y="'+(zeroY-6).toFixed(1)+'" font-size="9" fill="#6B7A8D" font-family="DM Mono">break-even</text>'+
  '</svg>';
}

/* CSV export */
function exportCSV(){
  var m = window.__lastModel; if(!m) return;
  var rows = [['DCFC BESS Pro Forma — ClearSky-OMEGA']];
  rows.push(['Site', $('i_site').value]);
  rows.push(['Rate', m.R.name]);
  rows.push([]);
  rows.push(['Net investment', Math.round(m.netCapex)]);
  rows.push(['Project IRR', m.projIrr===null?'n/a':(m.projIrr*100).toFixed(2)+'%']);
  rows.push(['NPV', Math.round(m.projNpv)]);
  rows.push(['Payback (yr)', m.paybackYr===null?'>life':m.paybackYr.toFixed(2)]);
  rows.push(['Lifetime ROI', (m.roi*100).toFixed(0)+'%']);
  rows.push([]);
  rows.push(['Year','Charging','BESS stack','O&M','Net CF','Cumulative']);
  for(var i=0;i<m.years.length;i++){ var Y=m.years[i];
    rows.push([Y.y, Math.round(Y.charging), Math.round(Y.demand+Y.arb+Y.vpp), Math.round(Y.om), Math.round(Y.net), Math.round(Y.cum)]); }
  var csv = rows.map(function(r){ return r.join(','); }).join('\n');
  var blob = new Blob([csv], {type:'text/csv'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='dcfc-bess-proforma.csv'; a.click();
}

/* ══════════ INIT ══════════ */
function initRateSelect(){
  var sel=$('i_rate'); var h='';
  for(var i=0;i<RATE_ORDER.length;i++){ var k=RATE_ORDER[i]; h+='<option value="'+k+'">'+RATES[k].name+'</option>'; }
  sel.innerHTML=h;
}
function wire(){
  var ids=['i_rate','i_kwh','i_peak','i_retail','i_bkw','i_bkwh','i_rte','i_deg','i_capex','i_itc','i_rebate','i_om','i_disc','i_life','i_vpp','i_growth','i_site'];
  for(var i=0;i<ids.length;i++){ var el=$(ids[i]); if(el){ el.addEventListener('input',render); el.addEventListener('change',render); } }
}
function boot(){
  // pick up workspace branding if present
  try{ if(window.OMEGA_WORKSPACE){ $('tb-client-badge').textContent=window.OMEGA_WORKSPACE.accountTier||'Enterprise';
    if(window.OMEGA_WORKSPACE.exportBrand&&window.OMEGA_WORKSPACE.exportBrand.poweredBy) $('foot-powered').textContent=window.OMEGA_WORKSPACE.exportBrand.poweredBy; } }catch(e){}
  initRateSelect(); wire(); render();
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
