FreeIndustry Art Style Guide
Placeholder and Production Visual Direction for Factory Assets
Purpose
This guide defines the visual style for FreeIndustry’s factory art, especially for:

- factory floor materials
- machines
- conveyors
- storage
- pallets and materials
- workers and industrial objects
- overlays and in-world visual elements
  The goal is a clear, realistic, readable top-down industrial style suitable for a strictly overhead orthographic simulation game.

This style must support both placeholder assets and eventual production-quality art.

1. Core Visual Principles
   FreeIndustry’s art should feel:

- strictly top-down
- industrial
- practical
- readable
- grounded
- modular
- visually restrained
  The world should resemble a real industrial floor plan brought to life, not a cartoon factory and not an isometric strategy game.

The player should be able to quickly understand:

- what an object is
- where it is
- how big it is
- what it does
- where materials go in
- where products come out
- how it relates to nearby floor space
  Visual clarity is more important than decorative beauty.

2. Camera and Projection
   Mandatory camera rule

- Strict top-down orthographic only
- The camera looks straight down at 90 degrees
- All assets must be created for a directly overhead view
  Prohibited
- No isometric projection
- No oblique projection
- No three-quarter angle
- No perspective vanishing
- No visible front faces or side faces
- No tilted camera tricks
- No fake 3D presentation
  Implication for all art
  Every object must read correctly as if viewed from directly overhead:
- machines
- furniture
- pallets
- workers
- floor textures
- tools
- containers
- forklifts
- conveyors
- doors
- staging areas
  If an asset looks like it was drawn from an angle, it is wrong for this project.

3. Lighting
   Required lighting style

- Soft
- Neutral
- Overhead
- Evenly distributed
- Non-cinematic
  Lighting should help readability, not dramatize the scene.
  Desired characteristics
- gentle light/dark separation
- mild material shading
- subtle ambient shadowing
- top-lit appearance
- minimal directional bias
  Avoid
- strong side lighting
- dramatic cast shadows
- cinematic spotlights
- harsh contrast
- glowing effects
- deep black shadow pools
  Practical rule
  Lighting must never imply an angled camera.
  If shadows make an asset feel tilted or 3D in perspective, reduce them.

4. Color Palette
   Overall palette direction
   Use a restrained industrial palette built around:

- muted greens
- concrete grays
- steel grays
- desaturated yellows
- worn industrial blues
- dark rubber and black utility tones
- occasional muted safety orange or red accents
  General mood
  The environment should feel:
- functional
- believable
- slightly worn
- industrial
- serious
- readable
  Color usage rules
- Most objects should sit within a muted, practical range
- Accent colors should help identify function, not dominate the image
- Safety colors should be used intentionally and sparingly
- Large factory scenes should not become visually noisy
  Good color examples
- concrete gray
- cool steel
- faded machinery green
- industrial yellow
- dull blue-gray
- dark hose/rubber black
- rust-brown accents
- off-white labels or painted markings
  Avoid
- oversaturated neon colors
- toy-like color schemes
- bright cartoon primaries
- overly glossy fantasy colors
- rainbow visual clutter

5. Texture Density
   Required texture density

- Moderate
  This is important.

Textures should provide believable industrial surface detail without overwhelming readability.
Good texture behavior

- visible but controlled surface wear
- subtle dirt, scuffs, scratches, seams, stains
- enough variation to avoid flatness
- enough restraint to keep silhouettes clean
  Surfaces that may show texture
- concrete floors
- steel casings
- painted machine housings
- pallets
- storage racks
- belts
- hazard markings
- wood surfaces
- rubber parts
  Avoid
- hyper-detailed noisy textures
- photographic clutter
- overly smooth textureless surfaces
- grime so heavy that forms become unclear
  Rule of thumb
  At a gameplay zoom level, the player should still easily recognize the object’s shape and role.

6. Machine Outline Readability
   Mandatory requirement

- Machine outline readability must be high
  Machines are gameplay-critical objects, so their silhouettes and footprints must be easy to understand at a glance.
  Required characteristics
- strong top-down silhouette
- clear edge separation from the floor
- readable footprint shape
- visible functionally important zones
- consistent shape language
  Important visual cues
  Machines should make it visually understandable where the following are likely located:
- input side
- output side
- operator side
- service/refill point
- maintenance access zone
- conveyor attachment zone
- hazardous moving area if relevant
  Preferred design strategy
  Favor:
- clean major forms
- simple readable top shapes
- limited but meaningful surface details
- visible hatches, tanks, rollers, feed areas, lids, or access panels
  Do not bury the machine under too much texture detail.
  Avoid
- visually ambiguous blobs
- machine shapes that disappear into the floor
- unreadable silhouettes
- too many tiny decorative details
- excessively busy top surfaces

7. Background Clutter
   Required background behavior

- Low clutter
  The floor and environment must support gameplay, not compete with it.
  Guidelines
- keep floor patterns controlled
- keep environmental decoration sparse
- do not overload scenes with loose props
- avoid excessive decals unless functionally relevant
- allow empty visual breathing room
  The floor should do this:
- establish material
- establish scale
- establish wear and realism
- support the machine art
  The floor should not do this:
- visually overpower machinery
- create confusion about boundaries
- look busier than the gameplay objects

8. No Isometric Faces
   Hard rule

- No visible isometric faces
- No front-facing or side-facing geometry cheats
  That means:
- no visible machine side walls
- no perspective top planes
- no oblique cabinet faces
- no “angled front” visual cheats
  Objects must be represented only through what is visible from directly above.
  Allowed
  You may imply form through:
- top-surface paneling
- edge outlines
- gentle shading
- vents
- access hatches
- lids
- rollers
- tanks
- openings
- labels
- grates
- material zones
  Not allowed
  Any illustration style that reveals the side of the object.

9. No Cartoon Exaggeration
   Hard rule

- No cartoon exaggeration
  FreeIndustry should feel industrial and credible.
  Avoid
- oversized comic proportions
- goofy machine shapes
- toy-like simplification
- exaggerated bounce or expression
- whimsical stylization
- exaggerated outlines
- thick cartoon strokes
- playful caricature
  Preferred tone
- grounded
- utilitarian
- restrained
- semi-realistic
- practical
- legible
  The goal is not photorealism, but credible industrial stylization.

10. Floor Art Style
    Floor visuals should be

- top-down
- modular
- subdued
- realistic
- easy to tile
- readable under machines and overlays
  Examples of appropriate floor materials
- standard concrete
- worn concrete
- polished concrete
- industrial epoxy
- painted concrete
- safety-marked floor zones
- steel plate
- diamond plate
- anti-slip industrial flooring
- warehouse marking paint
- office-adjacent utility tile or neutral flooring where needed
  Floor design rules
- visible seams are allowed where appropriate
- decorative pattern must not conflict with the construction grid
- texture variation should be subtle
- hazard markings should be functional and deliberate
- floor materials should remain readable at multiple zoom levels

11. Machine Art Style
    Machines should look

- industrial
- top-down
- functional
- proportional
- specific
- readable
  Suggested machine appearance
- painted sheet-metal housings
- exposed rollers where appropriate
- feed tables
- access lids
- fluid tanks
- control boxes
- maintenance panels
- conveyors or transfer points
- color coding only where functionally helpful
  Machine finish
- muted industrial colors
- moderate wear
- subtle grime
- limited reflective shine
- visible but not exaggerated use history

12. Materials, Inventory, and Props
    Inventory items
    Pallets, containers, crates, carts, and material stacks should:

- match the same top-down orthographic rule
- use restrained texture detail
- remain easy to identify
- clearly contrast with the floor
- look industrial, not decorative
  Wood and raw materials
  For things like boards, panels, or bundles:
- keep the top-down read obvious
- show believable grouping
- indicate orientation cleanly
- avoid cluttered line work

13. Workers and Vehicles
    Workers
    Workers should:

- be readable from overhead
- have simple, clear silhouettes
- use practical workwear colors
- not be overly tiny-detail dependent
- not appear cartoonishly stylized
  Vehicles and mobile equipment
  Forklifts, carts, pallet jacks, and other mobile equipment should:
- read clearly from directly above
- preserve true overhead proportions
- use the same industrial palette
- remain simpler than hero objects, but still believable

14. Visual Hierarchy
    The player’s eye should prioritize information in this order:
1. machine footprint and identity
1. important stock / objects / workers
1. input-output and operational relationships
1. floor type and space boundaries
1. minor surface detail
   This means the art must support gameplay hierarchy.

Floor detail should not outrank machines.
Minor decals should not outrank materials or moving objects. 15. Style Consistency Rules
All placeholder and production assets should follow the same rules:

- same orthographic viewpoint
- same lighting logic
- same general palette family
- same texture density range
- same readability expectations
- same grounded industrial tone
  Do not mix:
- realistic top-down floors
- cartoon machines
- semi-isometric props
- painterly lighting
- flat mobile-game icons
  Everything should feel like it belongs to one coherent simulation world.

16. Asset Approval Checklist
    Before approving any asset, verify:
    Perspective

- Is it strictly top-down?
- Does it avoid all isometric or angled faces?
  Lighting
- Is the lighting soft, neutral, and overhead?
- Does it avoid cinematic or directional drama?
  Palette
- Does it use restrained industrial colors?
- Are any accent colors functional rather than distracting?
  Texture
- Is detail moderate rather than noisy or flat?
- Does the texture support readability?
  Readability
- Is the object silhouette clear?
- Can the footprint be understood quickly?
  Clutter
- Is the background controlled and quiet?
- Does the asset stand out clearly from the floor?
  Style tone
- Does it feel grounded rather than cartoony?
- Does it fit a serious industrial simulation?
  If the answer to any of these is “no,” revise the asset.

17. AI Art Generation Guidance
    When generating placeholder art with AI, always emphasize:

- strict top-down orthographic view
- overhead-only perspective
- industrial realism
- muted palette
- moderate texture detail
- high readability
- low clutter
- no cartoon style
- no isometric faces
- clean silhouette
- neutral lighting
- top-down factory asset
  Example style phrase
  Use wording like:
  “strict top-down orthographic industrial game asset, realistic overhead factory machine, soft neutral overhead lighting, muted industrial greens and grays, moderate texture detail, high outline readability, low background clutter, no isometric faces, no cartoon exaggeration”

18. Final Style Summary
    FreeIndustry’s visual style is:
    A realistic, restrained, strictly top-down industrial simulation style with soft overhead lighting, muted factory colors, moderate surface detail, highly readable machine silhouettes, low background clutter, and no isometric or cartoon stylization.
