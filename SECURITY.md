# Security policy

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's
**Private vulnerability reporting**: open the repository's **Security** tab and
choose **Report a vulnerability**. Do not open a public issue or pull request
for a security problem.

Include, when possible:

- the affected file, route or component;
- steps to reproduce, or a proof of concept against a **local** instance;
- the impact you expect (data exposure, privilege escalation, payment bypass…).

You should receive an acknowledgement within a few business days. Fixes are
made in the private repository that runs production and then published here.

## Scope and rules

- In scope: the code in this repository.
- Test only against your own local instance (see the README). Do not run
  automated scanners or load tests against the production service, do not
  access accounts or data that are not yours, and do not attempt to trigger
  real payments.
- The knowledge base and AI instructions in `knowledge/`, `src/lib/ai/prompts*.ts`
  and `src/lib/ai/motores/` are samples; findings about the production legal
  content are out of scope.
