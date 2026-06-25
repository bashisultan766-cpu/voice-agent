# Facility guideline documents for the voice agent
#
# STEP 1 — Google Sheets (recommended for many facilities)
#   Export your client's spreadsheet as CSV and save as:
#     ../facility_guidelines.csv
#   Required columns: facility_name, website_url, allowed_formats, disallowed_formats,
#   disallowed_keywords, content_notes
#   Optional: aliases, city, state, source_pdf (filename in this folder)
#
# STEP 2 — PDF documents
#   Place client PDFs in this folder, e.g.:
#     tdcj_huntsville_rules.pdf
#     california_cdcr_guidelines.pdf
#   Name files with the facility name so they auto-match.
#   Or set source_pdf in the CSV to link a row to a specific PDF.
#
# STEP 3 — Build the agent knowledge base
#   From services/twilio-voice-agent:
#     python -m app.scripts.ingest_facility_documents
#
# STEP 4 — Restart the voice agent
#
# The agent will then:
#   - Read each book on a Shopify order (when customer gives order number)
#   - Match titles/tags against facility rules from your documents
#   - Explain why some books were returned and others accepted
#   - Share the facility website URL from your data
#   - Suggest similar paperback books that meet the rules
