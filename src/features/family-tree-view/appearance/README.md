# Зоряне оформлення дерева

`Родове дерево → Відображення дерева → Зоряне небо` opts the current user's tree into a night background with luminous cards/sectors. `Рух неба` independently pauses/resumes the sky. Both flags travel through the existing normalized `family_tree_user_preferences.appearance` JSON and local cache; no migration is needed. Defaults: existing light background, motion enabled when opting into the sky. Palette hues and genealogy data are never overwritten.

- Classic and direct-pedigree views share `FamilyTreeViewport`. Theme changes repaint edges but do not rebuild its worker layout, change camera coordinates, or reload data.
- Circular and ancestor/descendant fan charts inherit the saved settings and expose window-local sky/motion overrides. SVG/PNG/print exports clone a static snapshot of the sky, resized to the complete diagram's bounds, with the current colors and existing brand.
- Classic/direct trees and the constellation use the shared `StarrySkyCanvas` with actual viewport dimensions, pixel-sized stars and no camera zoom. `StarrySkyBackground` remains the bounded decorative SVG (160 stars) for circular/fan diagrams and their vector exports. Animation is capped at 30 Hz; no per-frame React state or per-person updates.
- `skyComets.ts` drives both this SVG and the constellation's existing bounded Canvas. Seeded randomness keeps each flight stable while varying edges/direction, color, duration, tail length and start delay between flights and sessions. At most one comet appears at a time, with quiet intervals and smooth fades.
- `useSkyMotionEnvironment` stops animation on hidden tabs and respects live `prefers-reduced-motion`. Explicit pause and unmount cancel scheduled frames. Stars remain available without motion.

The sky is artistic decoration, not an astronomical map or extra family members. Verify both sides of the toggle, all five views, palette contrast, camera/request/worker stability, pause, reduced motion, hidden tab, mobile controls and exported SVG rasterization. Unit coverage: `test/familyTreeStarryBackground.test.ts`, appearance/color tests and the constellation regression suite.
