# Frozen save fixtures

Save files written by earlier FreeIndustry builds (DECISIONS ADR-0027). They are
binary SQLite databases and are **never regenerated**: each one proves that a
later build still loads a real old save (directly, through a migration, or by
refusing it with a clear message).

| File                                  | Written by                                                 | Contents                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format-1-pending-probes.fisave`      | Step 04, save format 1, kernel 1, rules v1 (seed 19960101) | Day 0 at 01:35, revision 4, two probes pending; continues to fixed end-of-day fingerprints (`tests/unit/persistence/save-fixtures.test.ts`). From Step 05 it is upgraded to format 2 on load, with a backup, and still reaches them                                                                                                                     |
| `format-2-company-books.fisave`       | Step 05, save format 2, kernel 1, rules v1 (seed 19960105) | Day 45 at 15:00, revision 5: a company with $50,000 capital, a paid deposit, standing-order rent, a $30,000 bill overdue for lack of funds, bills pending; continues to fixed day-120 fingerprints. From Step 07 it is upgraded to format 3 on load, with a backup, and still reaches them                                                              |
| `format-3-leased-workshop.fisave`     | Step 07, save format 3, kernel 1, rules v1 (seed 19960107) | Day 100 at 12:00, revision 1: the base content's three cities embedded, a company with $2,600 leasing 8 Canal Street for six months, February and March rent paid, April's overdue; continues past the end of the lease to fixed day-200 fingerprints. From Step 08 it is upgraded to format 4 on load, with a backup, and still reaches them           |
| `format-4-installed-equipment.fisave` | Step 08, save format 4, kernel 1, rules v1 (seed 19960108) | Day 40 at 12:00, revision 6: the base content with building structure and catalogs embedded, a company leasing 20 Canal Street (with its mezzanine) for a year, a 3,658 × 1,829 mm panel saw installed turned 90°, a bench installed on the mezzanine and moved, a bench held by its dealer; continues past the lease end to fixed day-400 fingerprints |

A new fixture is added when a save format, kernel format or rules version is
introduced, using `scripts/write-save-fixture.ts` as the pattern.
