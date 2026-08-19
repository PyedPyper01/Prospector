# Sourcing tooling

Lives in the repo on purpose. The previous generation of these scripts sat in /private/tmp and were pruned
by macOS along with the portable Node they depended on, taking the deploy tooling with them.

- `national.py` — the main runner. One trade across every postcode area, geo-targeted by outcode centroid.
  `MAX_OUTCODES=14 python3 national.py Florists CO CM IP`
- `post.py` — writes to the supplier store. Refuses any row without a website; skips anything already held,
  matching on domain (reliable) rather than a stripped-down name (which once collapsed "Florist Bromley" and
  "Bromley Florist" into one).
- `osm_area.py` — free OpenStreetMap enumeration across a whole postcode area. Good names, patchy websites;
  useful as a cross-check on what the Maps route may have missed.

Add a trade by adding one line to `TRADES` in national.py: the search synonyms, a regex of Google categories
to KEEP, and a regex to DROP. Filtering is on Google's own category label, never on the business name.
