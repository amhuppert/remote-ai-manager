# Portable ticket bundles

Use **Export bundle** on a ticket to capture its context, transfer the downloaded
`.cc-ticket.gz` file, then use **Import bundle** on the destination's Tickets page.
Choose an existing local project before importing. Transfer code through Git
separately.

Export includes the selected ticket's fields, notes, file attachments, complete
status-update history, relationship descriptions, and session history. It captures
full CC transcript files (including stored tool activity and thinking), referenced
images, existing compactions, registered documents, linked specifications,
Alignment charters/decisions, and ticket-linked memory notes. It follows attached
conversations and all conversations in attached or current/historical work sessions.
It does not scan prose for additional file paths or recursively export other tickets.

Review missing content before downloading. If a transcript, summary, or file is
unavailable, the review lists it and requires acknowledgment. The downloaded archive
and imported index keep that omission report. A preparation is immutable and lasts
24 hours; acknowledgment applies to that preparation, even if the source changes.
A ticket mutation during capture requires preparing again. Transcripts are captured
as available during preparation; any incomplete record is retained and disclosed.

Import creates a ticket with a new local number, preserving the source status and
identity. Historical status updates, session records and relationships are indexed
source documents, not live references to destination records. Notes remain notes;
archived conversations and supporting artifacts become file attachments. **Start
work** materializes those documents into the destination session and registers them
as reference documents. `bundle-index.md` maps original sources to local files and
checkout roots, with relative links that work beside the materialized index.
Original transcript and document text remains unchanged. Related-ticket numbers
identify source tickets; they never link to coincidentally matching local numbers.

Repeated imports warn and require confirmation to create another copy. There is no
synchronization or restoration of backend conversation continuity.

## CLI

```sh
cctl ticket export my-project#7 --out ticket.cc-ticket.gz
cctl ticket import --archive ticket.cc-ticket.gz --project destination
```

When export reports omissions, inspect them and repeat the command using the exact
preparation ID and digest it prints:

```sh
cctl ticket export my-project#7 --out ticket.cc-ticket.gz \
  --prepared <id> --acknowledge <digest>
```

For a duplicate import, review the warning and confirm another copy:

```sh
cctl ticket import --prepared <id> --allow-duplicate --project destination
```

A preparation can also be reused after a CLI wait timeout. Export uses `--prepared`
with the original ticket reference; import uses it instead of `--archive`.

## Storage and validation

Version 1 is a gzip-compressed JSON archive, identified by `cc-ticket-bundle`.
Binary documents use base64 with SHA-256 checksums. Import validates the version,
structure and checksums before creating a ticket. Archive member names are data;
import assigns fresh attachment IDs and sanitized filenames rather than extracting
arbitrary paths. Stored preparations expire after 24 hours and are cleaned on the
next preparation.

Compressed and expanded archives have a 256 MiB ceiling. Exceeding an archive
limit fails explicitly; export never truncates content to fit. Ticket and attachment
rows commit together, with duplicate provenance checked in the same SQLite
transaction. File staging failures remove staged content without creating a ticket.
