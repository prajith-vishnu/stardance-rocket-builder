# Stardance Rocket Builder

A 3D rocket building and launch game made for Hack Club's Stardance
challenge. You assemble a rocket from parts on a launch pad, check the
stats, and launch it. Points from each flight unlock better parts, and
your progress is saved in the browser.

Play it here: [stardance-rocket-builder.vercel.app](https://stardance-rocket-builder.vercel.app)

## Features

- 3D build mode with orbit camera, realistic metal materials, and shadows
- Twelve rocket parts: nose cones, fuel tanks, three engine tiers, fins,
  strap-on boosters, and a parachute
- Arcade flight physics: thrust, fuel burn, drag, and stability. Rockets
  without enough fins visibly wobble and tumble
- Particle-based engine exhaust and animated booster separation
- Manual engine cutoff on the spacebar, for efficiency runs and
  saving fuel for the landing
- Altitude telemetry graph after every flight, with markers for
  burnout, separation, and chute deploy
- Sky that fades from daytime blue to a starfield as you climb, with
  a cloud layer to punch through on the way
- Three missions: Max Altitude, Safe Landing, and Efficiency
- Part unlocks and best scores persist between sessions
- All sound effects generated in the browser with the Web Audio API

## How to Play

1. Pick parts from the palette on the left. A rocket needs at least one
   engine and one fuel tank. Fins keep it pointed the right way.
2. Watch the stats panel: thrust-to-weight has to be above 1 to lift
   off, and low stability means a bumpy ride.
3. Pick a mission, hit Launch, and watch it go. Press space mid-flight
   to cut the engine early - unburned fuel counts for the efficiency
   score, but you keep carrying its weight.
4. Spend the points you earn in the Parts Catalog to unlock bigger
   tanks, stronger engines, boosters, and the parachute.

Drag to orbit the camera in build mode, scroll to zoom.

## Built With

- JavaScript
- Three.js
- HTML5 / CSS
- Web Audio API

## Running Locally

The game uses ES modules, so it needs to be served over HTTP rather
than opened straight from the filesystem. Any static server works:

```
python3 -m http.server
```

Then open http://localhost:8000 in a browser.

## Acknowledgments

Claude was used to help write parts of the code for this project.
