The keyframe and delta decoder as released with format 1.2 (`src/constants.ts` and `src/frame.ts`, imports
pointed at the unchanged `src` modules). `test/vehicle.test.ts` reads the 1.3 vectors (`keyframe-vehicle`, `delta-vehicle`) with it to prove that a
deployed 1.2 client skips the vehicle columns and reads the same trips (FORMAT.md section 6). Do not edit.
