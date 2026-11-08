# FreeIndustry — Expansion Industrial Art Pack 02

Companion to FreeIndustry Starter Art Pack. All artwork is overhead 2D industrial concept art; includes **separately extracted RGBA PNGs** grouped by type and the uncut reference sheet.

## Important integration notes

- These are **AI-generated prototype art cutouts**, not production sprites. Cutout transparency is approximate and may require edge cleanup.
- Source images are not metrically scaled or tested for real equipment proportions. Render each sprite at the actual footprint in millimeters from the machine definition.
- The underlying construction grid remains **500 × 500 mm**, but machine ports, operator stations, and clearance requirements should be represented with their own true millimeter geometry.
- No workers or floor materials are included in this expansion.
- For the `markings/` sprites, the image is a decal sample, not authoritative zone geometry.
- To avoid double counting, this ZIP deliberately contains only **new** assets and does not include the original pack.

## Folder organization

- `machines/` — manufacturing and finishing equipment
- `handling/` — material-moving and automation equipment
- `pallets/` — empty pallets and loaded pallet variations
- `storage/` — empty and populated racks/shelves
- `utilities/` — vessels, cooling and industrial utility equipment
- `building/` — walls, partitions, railings, access and safety elements
- `markings/` — overhead industrial decals/area marks
- `misc/` — small shop and safety equipment

PNG filenames are snake_case. `manifest.json` lists all exported assets and their source crop bounds.
