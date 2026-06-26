# Client facility policy CSV files

Place the client's ~51 facility/state policy CSV files in this folder.

The ingestion script loads every `*.csv` file here plus the legacy
`facility_guidelines.csv` at the parent level.

Run from `services/twilio-voice-agent`:

```
python scripts/ingest_facility_csv_policies.py
```

Expected columns (flexible — aliases supported):

- facility_name (required)
- state
- allowed_books / allowed_magazines / allowed_newspapers (yes/no/allowed/restricted)
- restricted_content
- policy_summary / content_notes
- policy_url / website_url
- allowed_formats / disallowed_formats

Do not commit sensitive client data unless approved.
