/* ================================================================================
   MISSION CONFIG — the two pre-launch selections the user makes that the physics engine reads:
   where the flight is going, and how it ascends. They live here, apart from both the physics and
   the UI, because ui/profile-ui.js writes them and sim/physics.js + sim/step.js read them — a
   shared home avoids a UI module having to import from physics or vice versa.
   ================================================================================ */
const DEFAULT_DESTINATION = 'earth-orbit';
let destination = DEFAULT_DESTINATION; // 'earth-orbit' | 'moon' | 'mars'
function setDestination(d){ destination = d; }
/* ---------------- flight profile setting ----------------
   User-selectable ascent style: 'gravity-turn' (default, realistic — pitches over toward
   horizontal so the vehicle can build the horizontal velocity an orbit requires) or
   'straight-up' (thrust stays pointed dead vertical the whole burn, for anyone who wants a
   simple vertical hop instead of chasing an orbit — it will never achieve one, since orbital
   velocity IS horizontal velocity, but that's an intentional, honest tradeoff of the mode). */
const DEFAULT_FLIGHT_PROFILE = 'gravity-turn';
let flightProfile = DEFAULT_FLIGHT_PROFILE;
function setFlightProfile(p){ flightProfile = p; }

export { DEFAULT_DESTINATION, DEFAULT_FLIGHT_PROFILE, destination, flightProfile, setDestination, setFlightProfile };
