# Contributing

Thanks for helping make this dataset better.

## Add or fix data

- Edit the CSV files in `data/`. Keep IDs unique and use the existing `country_id`, `cause_id` and `company_id` values (or add new rows to those files first).
- Allowed values: `environment` = land, freshwater, marine, mixed. `source_type` = tanker, cargo_ship, pipeline, offshore_platform, onshore_well, storage_facility, rail, deliberate, unknown. `status` = ongoing, contained, closed, unknown. `volume_confidence` = low, medium, high.
- Volume is in barrels. Leave it empty if there is no reliable estimate.
- Include a source link in `source_references.csv` for anything new.
- Run `python scripts/build.py` before opening a pull request. It must finish without errors.

## Change the schema

Update both `db/sqlite/schema.sql` and `db/mysql/schema.sql`, and keep `scripts/build.py` in sync.

## Code

The website is plain HTML, CSS and JavaScript in `web/` with no build step. Test locally with `python -m http.server -d web`.
