const G0 = 9.80665;
// Real Earth-scale two-body constants — the vehicle now flies in a genuine gravitational field
// around a spherical planet, rather than under a flat, constant "-g0, straight down" field. This
// is what makes an actual closed orbit (and a real escape trajectory) possible: gravity always
// points at the planet's center, and its strength falls off with 1/r², exactly like real orbital
// mechanics, instead of being a constant vertical deceleration that can never curve a trajectory
// into an ellipse.
const MU = 3.986004418e14;      // m^3/s^2, Earth's standard gravitational parameter (GM)
const R_PLANET = 6371000;       // m, mean Earth radius — altitude is always r - R_PLANET
const R_ATMOS = R_PLANET + 100000; // m, edge of the modeled atmosphere (Kármán line) — drag is ~0 beyond this anyway

/* ================================================================================
   DESTINATIONS — Moon and Mars, selectable before launch. This turns "escape Earth" from a dead
   end (the old sim just coasted forever on a hyperbolic orbit and called it done) into an actual
   interplanetary flight: real body masses/radii, the real Earth-to-body distance, a real coast
   under gravity (patched-conic — Earth's pull dominates near departure, the target body's pull
   takes over once inside its sphere of influence, exactly the same simplification real mission
   designers use for back-of-envelope trajectory work before a full N-body solve), and a real
   landing attempt on arrival using the SAME suicide-burn landing system already built for Earth,
   just re-parameterized with the target body's own surface gravity and radius.

   The interplanetary coast is modeled as 1D radial closure (distance-to-target shrinking under
   Earth's still-diminishing pull plus the target's growing pull) rather than a full 2D/3D vector
   integration — real transfer trajectories are only mildly curved compared to their enormous
   length, and this sim's existing (x,y) Earth-centric position vector isn't meaningful once the
   vehicle is millions of km away on a multi-day/month coast anyway (see TRANSFER phase in
   simStep). Once within the target's sphere of influence, the sim hands off to a fresh 2D
   position/velocity state centered on the TARGET body, reusing every bit of the existing
   two-body/landing physics (computeAccel, rk4Step, the suicide-burn system) verbatim. */
const BODIES = {
  moon: {
    id:'moon', name:'the Moon', short:'Moon',
    mu: 4.9048695e12, radius: 1737400, soi: 66100000,
    distanceFromEarth: 384400000, // m, mean Earth-Moon center distance
    // Real sphere-of-influence radius (soi, above) sets when TRANSFER ends and the real interplanetary
    // coast is "over" — but a passive freefall from all the way out at the real SOI (66,100km for the
    // Moon, 577,000km for Mars) under nothing but that body's own weak gravity would itself take DAYS
    // (verified: ~3 days for the Moon alone), which is a real physical fact but a terrible "landing
    // sequence" — real missions arrive already on a targeted, fast approach trajectory and begin
    // powered descent from a much lower altitude, not a standing start at the SOI edge. arrivalAlt is
    // that realistic descent-initiation altitude — captureArrival() places the vehicle here (still
    // moving at its real transfer-arrival speed), not at the SOI boundary itself, so the descent that
    // follows plays out in minutes, matching how Earth's own landing sequence already works.
    arrivalAlt: 15000, // m — roughly where a real powered-descent/landing sequence begins on the Moon
    g0: 1.62, // m/s^2 surface gravity
    hasAtmosphere:false,
    terrain: { landColor:'#8f8d88', landColor2:'#77746d', craterColor:'rgba(35,33,30,0.55)', hasOcean:false, hasWaterFeatures:false, mountainColor:null, skyColor:'#000000' },
    fact:'384,400 km away on average — a real transfer takes roughly 3 days under a Hohmann-class trajectory.',
  },
  mars: {
    id:'mars', name:'Mars', short:'Mars',
    mu: 4.282837e13, radius: 3389500, soi: 577000000,
    distanceFromEarth: 225000000000, // m, representative Earth-Mars transfer distance (varies 54.6M-401M km with alignment; this is a typical Hohmann-transfer-class value)
    arrivalAlt: 125000, // m — above Mars' modeled sensible atmosphere, a realistic entry-interface altitude
    g0: 3.72,
    hasAtmosphere:true, atmosScaleHeight: 11100, atmosSurfaceRho: 0.020, // kg/m^3 — Mars' CO2 atmosphere is ~1% of Earth's sea-level density
    terrain: { landColor:'#b56a41', landColor2:'#8f4f30', craterColor:'rgba(60,25,12,0.45)', hasOcean:false, hasWaterFeatures:false, mountainColor:'rgba(150,90,60,0.4)', skyColor:'#2a1810' },
    fact:'A real Hohmann transfer to Mars takes roughly 6-9 months depending on launch alignment.',
  },
};
// The Karman line (100km — the conventional edge of space) gets its own distinctly-colored ring
// so there's a specific, labeled, visible threshold for "this is where atmosphere ends and space
// begins," instead of altitude just being a number climbing in the HUD with no visual landmark.
const KARMAN_LINE_M = 100000;

export { BODIES, G0, KARMAN_LINE_M, MU, R_ATMOS, R_PLANET };
