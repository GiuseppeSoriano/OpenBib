# Security Policy

Security reports are taken seriously. Please use coordinated, private disclosure so maintainers have time to investigate and prepare a fix before details become public.

## Supported versions

OpenBib is currently in alpha and has not published a stable release series. Security fixes are applied to the latest code on the `main` branch. Older commits, forks, and modified deployments are not supported by this policy.

## Reporting a vulnerability

Do **not** open a public issue, pull request, or discussion for a suspected vulnerability.

Use GitHub's private vulnerability reporting flow:

<https://github.com/GiuseppeSoriano/OpenBib/security/advisories/new>

Include as much of the following as possible:

- the affected component and code revision;
- the vulnerability type and its potential impact;
- clear reproduction steps or a minimal proof of concept;
- any prerequisites or deployment assumptions;
- a suggested mitigation, if you have one;
- whether the issue has been disclosed anywhere else.

You should receive an acknowledgement within 5 business days. The maintainer will validate the report, agree on a disclosure timeline where possible, and keep you informed when there is material progress. Please allow a reasonable period for remediation before public disclosure.

If private vulnerability reporting is temporarily unavailable, contact the maintainer through the contact information on the [GitHub profile](https://github.com/GiuseppeSoriano) and share only enough public detail to establish a private channel.

## Scope

Reports about vulnerabilities in OpenBib's own code and default deployment configuration are in scope. Availability problems or vulnerabilities in OpenAlex, arXiv, Crossref, Europe PMC, Zotero, GitHub, Docker, or other upstream services should be reported directly to the relevant provider unless OpenBib's integration makes the issue exploitable in a distinct way.

Please avoid accessing other people's data, degrading third-party services, running denial-of-service tests, or using automated scanning against a public deployment without the operator's permission.
