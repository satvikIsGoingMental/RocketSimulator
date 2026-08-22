/* ================================================================================
   ROCKET ROSTER — same figures as rocket-calc.html's calculator
   ================================================================================ */
const noseCd = { conical:0.50, ogive:0.38, elliptical:0.42, flat:0.82 };

const stockRockets = [
  {
    id:'electron', name:'Rocket Lab Electron', maker:'Rocket Lab', diam:1.2,
    isp:311, of:2.55, density:1030, nose:'ogive', engines:9,
    mprop:9200, mpay:225, fstruct:0.11, thrust:224, nboost:0, fboost:0, mboost:0,
    fact:'Small orbital launcher, 9× Rutherford engines, carbon-composite airframe.'
  },
  {
    id:'f9', name:'Falcon 9 (core)', maker:'SpaceX', diam:3.7,
    isp:282, of:2.56, density:1030, nose:'ogive', engines:9,
    mprop:395700, mpay:22800, fstruct:0.045, thrust:7607, nboost:0, fboost:0, mboost:0,
    fact:'9× Merlin 1D, reusable first stage, no strap-on boosters.'
  },
  {
    id:'fh', name:'Falcon Heavy', maker:'SpaceX', diam:3.7,
    isp:282, of:2.56, density:1030, nose:'ogive', engines:9, boosterEngines:9,
    mprop:395700, mpay:63800, fstruct:0.045, thrust:7607, nboost:2, fboost:7607, mboost:395700,
    fact:'Falcon 9 core plus two Falcon 9-derived side boosters — 27 Merlins total at liftoff.'
  },
  {
    id:'deltaIVh', name:'Delta IV Heavy', maker:'ULA', diam:5.1,
    isp:412, of:5.5, density:360, nose:'ogive', engines:1, boosterEngines:1,
    mprop:200000, mpay:14200, fstruct:0.09, thrust:2891, nboost:2, fboost:2891, mboost:200000,
    fact:'Hydrolox core flanked by two identical hydrolox booster cores (triple-body layout).'
  },
  {
    id:'saturnv', name:'Saturn V (S-IC stage)', maker:'NASA', diam:10.1,
    isp:263, of:2.27, density:1000, nose:'conical', engines:5,
    mprop:2077000, mpay:118000, fstruct:0.055, thrust:35100, nboost:0, fboost:0, mboost:0,
    fact:'5× F-1 engines burning RP-1/LOX — still the highest-thrust first stage ever flown.'
  },
  {
    id:'starship', name:'Starship / Super Heavy', maker:'SpaceX', diam:9,
    isp:327, of:3.6, density:830, nose:'elliptical', engines:33,
    mprop:3400000, mpay:150000, fstruct:0.05, thrust:74500, nboost:0, fboost:0, mboost:0,
    fact:'33× Raptor methalox engines, fully reusable, widest stage flown to date.'
  },
  /* --------------------------------------------------------------------------------------------
     ESCAPE-CAPABLE VEHICLES — everything above tops out around 6,500-9,200 m/s of ideal Δv, well
     short of the ~11,190 m/s local escape velocity (and short of the ~9,400+ m/s a real ascent
     needs after gravity/drag losses to even reach a stable orbit) — this simulator models a single
     stage with no separation events, so none of the vehicles above can do more than fly a tall
     suborbital arc back to the ground. The three vehicles below are modeled as a REAL multi-stage
     vehicle's COMBINED stack — one simplified "stage" whose Δv matches what the real vehicle
     delivers in total once every stage has fired — which is the only way to represent an actual
     staged, escape-capable rocket within this simulator's single-stage physics. Confirmed against
     the actual sim (not just the ideal rocket-equation Δv): each one flies a real gravity-turn
     ascent and its specific orbital energy goes positive (a genuine hyperbolic departure, the same
     check the sim uses for 'reachedEscape'), not a scripted/forced outcome.
     -------------------------------------------------------------------------------------------- */
  {
    id:'saturnv-tli', name:'Saturn V + S-IVB (TLI stack)', maker:'NASA', diam:10.1,
    isp:440, of:3.5, density:700, nose:'conical', engines:5,
    mprop:3050000, mpay:38000, fstruct:0.028, thrust:42000, nboost:0, fboost:0, mboost:0,
    fact:'Modeled as the full Apollo stack — S-IC, S-II, and S-IVB combined into one high-Δv stage — the only vehicle to ever send humans past Earth orbit toward another world.'
  },
  {
    id:'centaur-class', name:'Centaur V (deep-space stack)', maker:'ULA', diam:5.4,
    isp:455, of:5.5, density:360, nose:'ogive', engines:1,
    mprop:500000, mpay:1200, fstruct:0.045, thrust:12000, nboost:0, fboost:0, mboost:0,
    fact:'A booster plus a hydrolox Centaur upper stage, modeled as one combined stack — RL10-class engines are the workhorse of real robotic missions departing Earth entirely.'
  },
  {
    id:'new-horizons-class', name:'Atlas V 551 + Centaur + Star 48 (fastest departure)', maker:'ULA', diam:3.8,
    isp:400, of:4.0, density:900, nose:'conical', engines:1,
    mprop:300000, mpay:220, fstruct:0.028, thrust:11000, nboost:0, fboost:0, mboost:0,
    fact:'Modeled on the New Horizons launch stack — booster, Centaur, and a solid Star 48B kick stage — the fastest Earth departure ever flown, real-world Earth-relative burnout speed above 16 km/s.'
  },
  /* --------------------------------------------------------------------------------------------
     LUNAR LANDERS — the three vehicles above are tuned to JUST barely escape, matching their real
     counterparts, so (correctly, per simStep's early-MECO cutoff — see the comment there) they burn
     essentially every drop of propellant getting to escape velocity and arrive at the Moon with only
     a few hundred m/s banked: nowhere near enough to survive the ~2,300 m/s a lunar arrival actually
     needs shed (66,100km real SOI radius down to the 15km arrivalAlt descent-start altitude, entirely
     under the Moon's own gravity — see captureArrival's vis-viva comment). These three are sized with
     real spare Δv margin on top of escape instead — closer to how an actual Apollo-style TLI stack
     PLUS a dedicated lunar-module-class descent stage would be sized together — so a landing attempt
     here isn't just theoretically possible but actually, verifiably lands (confirmed against the sim
     itself at each scale below: full Earth ascent, real escape, real 3-day transfer, real suicide-burn
     descent, genuine soft touchdown under LANDING_SAFETY_MARGIN's ignition-timing, not a scripted
     outcome). Scaled up together (T/W ~2.5-2.6, ~17,400-18,000 m/s ideal Δv) at three different sizes
     so the roster has a small/medium/heavy choice, same as the plain orbital vehicles above.
     -------------------------------------------------------------------------------------------- */
  {
    id:'lunar-lander-small', name:'Artemis-class Lander (single-stack, small payload)', maker:'Generic', diam:5.4,
    isp:465, of:5.5, density:360, nose:'ogive', engines:1,
    mprop:850000, mpay:2200, fstruct:0.020, thrust:22000, nboost:0, fboost:0, mboost:0,
    fact:'A hydrolox deep-space stack sized with real spare Δv beyond bare Earth escape — enough left over after the 3-day transfer to fly an actual suicide-burn touchdown on the Moon, not just reach it.'
  },
  {
    id:'lunar-lander-medium', name:'Artemis-class Lander (twin-engine, medium payload)', maker:'Generic', diam:6.6,
    isp:465, of:5.5, density:360, nose:'ogive', engines:2,
    mprop:1300000, mpay:4000, fstruct:0.018, thrust:34000, nboost:0, fboost:0, mboost:0,
    fact:'Scaled up from the small lander for a heavier payload — same margin philosophy: burn only to confirmed escape, then fly the leftover propellant down onto the Moon under its own engines.'
  },
  {
    id:'lunar-lander-heavy', name:'Artemis-class Lander (tri-engine, heavy payload)', maker:'Generic', diam:8.0,
    isp:465, of:5.5, density:360, nose:'ogive', engines:3,
    mprop:1900000, mpay:7000, fstruct:0.016, thrust:48000, nboost:0, fboost:0, mboost:0,
    fact:'The largest of the three landers — a heavier payload class (crewed-mission-sized) with the same comfortable post-escape Δv margin the smaller two rely on for a survivable touchdown.'
  },
];

export { noseCd, stockRockets };
