/* ==========================================================================
   omega-comed-listings.js  ·  ClearSky-OMEGA shared platform file
   --------------------------------------------------------------------------
   Registers the ComEd Capacity Finder's own data as a Site Finder property
   source, so the two tools browse the same parcels instead of the Site Finder
   browsing sample data next to a real map.

     CS_CI       industrial parcels   pin, owner, acreage, assessed value
     CS_EDC      for sale / for lease listing, broker, EXISTING SERVICE
     hosting     ArcGIS polygons      the circuit each parcel actually sits on

   This file exists rather than the mapping going into omega-listings-source.js
   because that file is tenant-neutral and knows nothing about a utility. It
   exists rather than going into omega-comed-layers.js because that file draws
   layers and knows nothing about listings. The join between the two is its own
   concern and this is it.

   Load order: omega-listings-source.js, omega-comed-layers.js, then this.
   ES5 only. Depends on both of the above and nothing else.
   ========================================================================== */
(function (root) {
  "use strict";

  var S = root.OmegaListings, LAY = root.OmegaComEdLayers;
  if (!S) { if (root.console) console.error("omega-comed-listings: OmegaListings not loaded."); return; }
  if (!LAY) { if (root.console) console.error("omega-comed-listings: OmegaComEdLayers not loaded."); return; }

  /* ------------------------------------------------------------- settings */
  var CFG = {
    /* Parcels carry acreage, never building area. Turning this on models a
       building from lot coverage, which is a GUESS — coverage on industrial
       land runs anywhere from 12% to 45% and the resulting kWh drives the
       load ceiling on the card. Off by default: a null kWh reads as "we do
       not know", an invented one reads as measurement. */
    estimateSqftFromAcres: false,
    coverage: 0.28,
    /* How close an EDC listing has to be to a parcel to be the same site.
       ~150 m. Beyond that they are two records, not one enriched one. */
    joinMetres: 150,
    /* A listing pinned to a ZIP centroid can sit a mile from the building.
       Feeders are block-scale, so attributing one would be confidently
       wrong — worse than leaving it blank. */
    feederForApproxPins: false
  };
  S.comedConfig = CFG;

  /* ---------------------------------------------------------------- utils */
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function str(v) { return v == null ? "" : String(v).trim(); }
  function inBox(lat, lon, b) {
    return lat != null && lon != null &&
           lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
  }
  /* Cheap equirectangular metres. Good to a metre or two at this latitude and
     it does not need to be better — it is deciding "same building or not". */
  function metres(aLat, aLon, bLat, bLon) {
    var x = (bLon - aLon) * 82500;     /* ~m per deg lon at 41.8N */
    var y = (bLat - aLat) * 111000;
    return Math.sqrt(x * x + y * y);
  }

  /* C&I energy-use intensity, kBtu/sqft-yr, converted at 3.412 kBtu/kWh.
     Read from the shared table in omega-listings-source.js rather than copied,
     because a copy is what let the demo provider drift 46% above this one on
     cold storage while a comment here claimed they matched. */
  var EUI = S.EUI || {};

  function modelKwh(sqft, type) {
    if (!sqft) return null;
    var e = EUI[type] != null ? EUI[type] : (EUI.Other != null ? EUI.Other : 45);
    return Math.round(sqft * e / 3.412);
  }

  /* The assessor's class words vary by county. Everything in the CS_CI bundle
     is industrially classed by definition, so the default is Industrial and
     the mapping only has to catch the ones that are usefully more specific. */
  function typeOf(s) {
    var t = str(s).toLowerCase();
    if (/cold|freezer|refriger/.test(t)) return "Cold Storage";
    if (/warehous|distribut|logistic/.test(t)) return "Warehouse";
    if (/manufact|plant|foundry|mill/.test(t)) return "Manufacturing";
    if (/data ?cent/.test(t)) return "Data Center";
    if (/flex/.test(t)) return "Flex";
    if (/office/.test(t)) return "Office";
    if (/retail|store/.test(t)) return "Retail";
    if (/vacant|land/.test(t)) return "Vacant Land";
    return "Industrial";
  }

  /* ------------------------------------------------------------ the join
     Every record gets its circuit from the SAME polygons the map is shaded
     with. Not a nearest-neighbour guess, not a second query — a point in a
     polygon that is already in memory, so 400 parcels cost zero extra calls.

     `feederId` null is a real answer and is left null. A card with a blank
     circuit tells a rep to check; a card with the wrong circuit tells a rep
     to quote a number that is not there. */
  function joinFeeder(rec, approx) {
    if (approx && !CFG.feederForApproxPins) {
      rec.feederId = null;
      rec.feederNote = "Pin is a ZIP centre, not the building — no circuit attributed.";
      return rec;
    }
    var f = LAY.feederAt(rec.lat, rec.lon);
    if (!f) { rec.feederId = null; return rec; }
    var cap = LAY.capacityOf(f);
    rec.feederId = f.feeder || null;
    rec.sub = f.sub || "";
    if (cap && cap.nameplate != null) {
      /* Passed as nameplate + queue, NOT as a pre-netted figure. The ledger
         subtracts the queue itself and then subtracts our own claims on top;
         handing it a netted number would subtract the queue twice. */
      rec.nameplate = cap.nameplate;
      rec.queue = cap.queue || 0;
    }
    return rec;
  }

  /* ------------------------------------------------------------- mapping
     ONE function per bundle, and the bundle's field names appear nowhere
     else. build_ci_layer.py and build_edc_layer.py own these names; if a
     rebuild renames a column, this is the only place that has to move. */
  function fromParcel(r) {
    if (!r || r.lat == null || r.lon == null) return null;
    var acres = num(r.acres != null ? r.acres : r.ac);
    /* The business kind outranks the assessor class because it is the more
       specific of the two and it moves a number. Everything in this bundle
       is industrially classed by definition, so `clsLabel` is "Industrial"
       on a foundry and on a cold store alike — and those model at 48 and 96
       kBtu/sqft. Letting the coarse label win halves the modelled load on
       exactly the sites worth calling. `subtype` below already reads it in
       this order; this line was the one disagreeing. */
    var type = typeOf(r.bizKind || r.cls || r.clsLabel);
    var sqft = CFG.estimateSqftFromAcres && acres
      ? Math.round(acres * 43560 * CFG.coverage) : null;
    var kwh = modelKwh(sqft, type);

    return {
      id: str(r.pin) || ("ci" + r.lat.toFixed(5) + "," + r.lon.toFixed(5)),
      addr: str(r.addr), city: str(r.city), state: "IL", zip: str(r.zip),
      lat: num(r.lat), lon: num(r.lon),
      sqft: sqft, lotAcres: acres,
      type: type,
      subtype: str(r.bizKind || r.cls) || "Industrially classed parcel",
      yearBuilt: num(r.yearBuilt),
      /* The operating business leads where we have one — that is who answers
         the phone. On industrial land the assessor's owner of record is
         usually a holding company, so it sits underneath rather than on top. */
      owner: {
        name: str(r.biz) || str(r.owner),
        mailing: str(r.ownerAddr),
        phone: str(r.bizPhone),
        email: ""
      },
      ownerOfRecord: str(r.owner),
      businessSrc: r.biz ? (r.bizSrc === "epa" ? "EPA permit" : "OpenStreetMap") : "",
      park: (r.parkN || 0) >= 3 ? { name: str(r.parkName) || "Industrial park", n: r.parkN } : null,
      lastSale: { date: "", price: null },
      assessedValue: num(r.val),
      photos: [],
      annualKwh: kwh != null ? { value: kwh, src: "proxy" } : null,
      feederId: null,
      src: "comed"
    };
  }

  function fromListing(e) {
    if (!e || e.lat == null || e.lon == null) return null;
    var sqft = num(e.sf);
    var type = typeOf(e.zone || e.kind);
    var kwh = modelKwh(sqft, type);

    return {
      id: "edc:" + (str(e.id) || str(e.n) || (e.lat.toFixed(5) + "," + e.lon.toFixed(5))),
      addr: str(e.a), city: str(e.c), state: "IL", zip: str(e.z),
      lat: num(e.lat), lon: num(e.lon),
      sqft: sqft, lotAcres: num(e.ac),
      type: type, subtype: str(e.n),
      yearBuilt: num(e.yr),
      owner: { name: str(e.nm), mailing: str(e.co2), phone: str(e.ph), email: str(e.em) },
      lastSale: { date: "", price: null },
      assessedValue: null,
      photos: [],
      annualKwh: kwh != null ? { value: kwh, src: "modelled" } : null,
      /* Read by the "On the market" card field. A listed site changes the
         sales approach: the BUYER signs the twenty-year lease, not the
         seller, so it earns its own line rather than being buried. */
      listed: { forSale: !!e.sale, forLease: !!e.lease, price: str(e.price), url: str(e.url) },
      /* The field nothing else on this platform carries. Grid capacity says
         what the circuit accepts; this says what is already built to the
         building, and a 200 A service means a service upgrade before the
         battery conversation is real. */
      service: e.kva ? { kva: num(e.kva), amps: num(e.amp), volts: num(e.v), src: str(e.kvaSrc) } : null,
      approx: !!e.approx,
      feederId: null,
      src: "comed"
    };
  }

  /* ------------------------------------------------------------- provider */
  S.register("comed", {
    label: "ComEd map data",
    note: "Industrial parcels and EDC listings from the Capacity Finder's own " +
          "bundles, each joined to its circuit through the same hosting polygons " +
          "the map is shaded with.",
    includeListings: true,
    lastTruncated: 0,

    search: function (bbox, filters, cb) {
      var self = this, limit = (filters && filters.limit) || 400;
      var parcels = null, listings = null, hostErr = null, shardErr = null, pending = 3;

      function step() { if (--pending === 0) finish(); }

      /* Circuits first and always — a record with no circuit is an address,
         not a result. It is one call for the whole viewport, and the draw
         layer reads the same cache, so switching this source on does not
         double the traffic to ComEd. */
      LAY.hostingIn(bbox, function (err) { hostErr = err || null; step(); });
      /* bbox scopes which county shards download. A partial failure still
         returns the counties that DID load — the error names the ones that
         did not, and that shows on the header rather than being swallowed. */
      LAY.loadCI(function (err, rows) {
        parcels = rows || [];
        if (err) shardErr = err;
        step();
      }, bbox);
      if (this.includeListings) {
        LAY.loadEDC(function (err, rows) { listings = err ? [] : rows; step(); });
      } else { listings = []; step(); }

      function finish() {
        var out = [], i, rec;

        for (i = 0; i < parcels.length; i++) {
          if (!inBox(parcels[i].lat, parcels[i].lon, bbox)) continue;
          rec = fromParcel(parcels[i]);
          if (rec) out.push(joinFeeder(rec, false));
        }

        /* A listing that sits on a parcel we already have is the same site
           seen twice. Merge rather than emit both: two cards for one building
           is how a rep calls the same owner twice in a week. */
        for (i = 0; i < listings.length; i++) {
          var e = listings[i];
          if (!inBox(e.lat, e.lon, bbox)) continue;
          var L2 = fromListing(e);
          if (!L2) continue;
          var host = e.approx ? null : nearestParcel(out, L2);
          if (host) {
            host.listed = L2.listed;
            host.service = L2.service;
            if (!host.sqft && L2.sqft) { host.sqft = L2.sqft; host.annualKwh = L2.annualKwh; }
            if (!host.owner.phone && L2.owner.phone) host.owner = L2.owner;
          } else {
            out.push(joinFeeder(L2, !!e.approx));
          }
        }

        /* Truncation drops the least interesting rather than whatever the
           bundle happened to list last: biggest deliverable circuit first,
           then biggest site. */
        out.sort(function (a, b) {
          return (b.nameplate || 0) - (a.nameplate || 0) ||
                 (b.lotAcres || 0) - (a.lotAcres || 0);
        });
        self.lastTruncated = Math.max(0, out.length - limit);
        if (out.length > limit) out = out.slice(0, limit);

        if (!out.length) {
          cb(new Error(
            parcels.length
              ? "No industrial parcels or listings in this view. Pan to a corridor with parcels on it."
              : "ci-industrial.js did not load on this host, so there are no parcels to browse."
          ));
          return;
        }
        /* Said out loud rather than shown as blank circuits. */
        var notes = [];
        if (hostErr) notes.push("ComEd hosting capacity did not answer (" + hostErr.message +
                                "), so circuits are blank on these records.");
        if (shardErr) notes.push(shardErr.message);
        if (self.lastTruncated) notes.push(self.lastTruncated.toLocaleString() +
          " more parcels are in view than the cap allows \u2014 zoom in or raise the limit.");
        self.lastNote = notes.join(" ");
        cb(null, out);
      }

      function nearestParcel(list, L2) {
        var best = null, bd = CFG.joinMetres, d, i;
        for (i = 0; i < list.length; i++) {
          d = metres(list[i].lat, list[i].lon, L2.lat, L2.lon);
          if (d < bd) { bd = d; best = list[i]; }
        }
        return best;
      }
    }
  });

  /* Listings only — for a rep working the on-market set, where every record
     has a broker and an existing service size. */
  S.register("comed-listed", {
    label: "ComEd map · on-market only",
    note: "The Illinois EDC for sale / for lease feed only. Every record carries " +
          "a broker and, where published, the site's existing electrical service.",
    search: function (bbox, filters, cb) {
      var pending = 2, listings = null;
      LAY.hostingIn(bbox, function () { if (--pending === 0) go(); });
      LAY.loadEDC(function (err, rows) { listings = err ? [] : rows; if (--pending === 0) go(); });
      function go() {
        var out = [], i;
        for (i = 0; i < listings.length; i++) {
          if (!inBox(listings[i].lat, listings[i].lon, bbox)) continue;
          var r = fromListing(listings[i]);
          if (r) out.push(joinFeeder(r, !!listings[i].approx));
        }
        if (!out.length) { cb(new Error("No EDC listings in this view.")); return; }
        cb(null, out);
      }
    }
  });

})(typeof window !== "undefined" ? window : this);
