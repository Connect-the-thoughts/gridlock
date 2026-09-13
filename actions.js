(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GridlockActions = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var M = 1e6;
  function km(city, linkId) { return city.links[linkId].lengthM / 1000; }

  /* THE PRICE LIST. These are balance constants as much as they are dollars:
     scripts/balance-report.mjs is what says whether a city is still a puzzle after
     a change here, so re-run `npm run balance` with any edit to this block. */
  var COST = {
    lanePerKm:  4.0 * M,   // widen one link, one more lane each way
    laneMin:    1.0 * M,   // …but no widening is a rounding error: design + mobilisation
    clearPerKm: 2.0 * M,   // buy the frontage a built-up widening needs
    clearMin:   0.5 * M,
    turnlane:   2.0 * M,   // rebuild one signalised approach with a turn bay
    roundabout: 4.0 * M,   // replace a signal with a roundabout
    coordinate: 1.0 * M,   // adaptive controllers + comms along one corridor
    frequency:  3.0 * M,   // per step: double, then triple, the bus frequency
    fare1:      2.0 * M,   // half fare
    fare2:      4.0 * M,   // free
    parkride:   2.0 * M    // one park-and-ride lot on a transit corridor
  };

  var TABLE = [
    { id: 'lane',      label: 'Add a lane',           scope: 'link',     effect: 'One more lane each way.',
      costOf: function (c, s) { return Math.max(COST.laneMin, Math.round(COST.lanePerKm * km(c, s) / 1e5) * 1e5); } },
    { id: 'clear',     label: 'Clear land',           scope: 'link',     effect: 'Makes room to widen a built-up road.',
      costOf: function (c, s) { return Math.max(COST.clearMin, Math.round(COST.clearPerKm * km(c, s) / 1e5) * 1e5); } },
    { id: 'turnlane',  label: 'Dedicated turn lane',  scope: 'node',     effect: 'Turning traffic stops blocking the through lane.',
      costOf: function () { return COST.turnlane; } },
    { id: 'roundabout',label: 'Roundabout',           scope: 'node',     effect: 'Replaces the signal. Faster until it fills.',
      costOf: function () { return COST.roundabout; } },
    { id: 'coordinate',label: 'Signal coordination',  scope: 'corridor', effect: 'Greens along the corridor line up.',
      costOf: function () { return COST.coordinate; } },
    { id: 'newroad',   label: 'New road',             scope: 'proposal', effect: 'Builds the corridor.',
      costOf: function (c, s) { return c.proposals[s].cost; } },
    { id: 'frequency', label: 'More buses',           scope: 'city', steps: 2, effect: 'Buses run twice, then three times as often.',
      costOf: function () { return COST.frequency; } },
    { id: 'fare',      label: 'Cheaper fares',        scope: 'city', steps: 2, effect: 'Half fare, then free.',
      costOf: function (c, s, step) { return step === 1 ? COST.fare1 : COST.fare2; } },
    { id: 'parkride',  label: 'Park-and-ride',        scope: 'zone',     effect: 'A third of this area rides in.',
      costOf: function () { return COST.parkride; } }
  ];
  var BY_ID = {}; TABLE.forEach(function (a) { BY_ID[a.id] = a; });

  function has(plan, action, site) {
    return plan.some(function (p) { return p.action === action && (site == null || p.site === site); });
  }
  function stepsTaken(plan, action) { return plan.filter(function (p) { return p.action === action; }).length; }

  /* true, or a short reason string. Mirrors spec §4.1/§4.2. */
  function eligible(city, plan, actionId, siteId) {
    var a = BY_ID[actionId]; if (!a) return 'unknown action';
    var S = city.sites;
    switch (actionId) {
      case 'lane':
        if (S.widenable.indexOf(siteId) < 0) return 'not widenable';
        if (has(plan, 'lane', siteId)) return 'already widened';
        if (city.links[siteId].builtUp && !has(plan, 'clear', siteId)) return 'needs Clear land first';
        return true;
      case 'clear':
        if (S.widenable.indexOf(siteId) < 0 || !city.links[siteId].builtUp) return 'nothing to clear';
        if (has(plan, 'clear', siteId)) return 'already cleared';
        return true;
      case 'turnlane':
        if (S.turnLane.indexOf(siteId) < 0) return 'no signal here';
        if (has(plan, 'turnlane', siteId)) return 'already added';
        if (has(plan, 'roundabout', siteId)) return 'a roundabout has no signal';
        return true;
      case 'roundabout':
        if (S.roundabout.indexOf(siteId) < 0) return 'not suitable';
        if (has(plan, 'roundabout', siteId)) return 'already built';
        if (has(plan, 'turnlane', siteId)) return 'remove the turn lane first';
        return true;
      case 'coordinate':
        if (!S.corridors.some(function (c) { return c.id === siteId; })) return 'not a signal corridor';
        if (has(plan, 'coordinate', siteId)) return 'already coordinated';
        return true;
      case 'newroad':
        if (!city.proposals[siteId]) return 'no such proposal';
        if (has(plan, 'newroad', siteId)) return 'already built';
        return true;
      case 'frequency': case 'fare':
        return stepsTaken(plan, actionId) < a.steps ? true : 'maxed out';
      case 'parkride':
        if (S.parkAndRide.indexOf(siteId) < 0) return 'no transit corridor here';
        if (has(plan, 'parkride', siteId)) return 'already built';
        return true;
    }
    return 'unknown action';
  }

  function costOf(city, item) {
    var a = BY_ID[item.action];
    return a.costOf(city, item.site, item.step || 1);
  }
  function totalCost(city, plan) { return plan.reduce(function (s, p) { return s + costOf(city, p); }, 0); }
  function consultantFee(city) { return Math.round(city.meta.budget * 0.05 / 1e5) * 1e5; }

  return { TABLE: TABLE, BY_ID: BY_ID, COST: COST, eligible: eligible, costOf: costOf, totalCost: totalCost, consultantFee: consultantFee };
}));
