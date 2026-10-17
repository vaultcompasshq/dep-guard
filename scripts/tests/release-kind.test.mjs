// Tests for the release-kind decision: given a pushed tag and the two
// package versions, is this a package release (publish everything) or an
// action-only release (publish nothing, move the tag, cut a Release)?
//
// This logic used to be four lines of bash inside .github/workflows/
// release.yml, and it only knew one shape: the tag must read "v" + the
// package version or the run fails. v0.6.1 was an action-only release --
// action.yml, README, CHANGELOG and docs moved, the packages stayed at
// 0.6.0 -- so the tag push produced a red Release run that stopped at that
// assertion before it could cut a Release page. The rule now admits that
// second shape, and this file is where the admission is kept honest,
// because the property the old assertion bought must survive it: a
// mistyped or mis-pointed tag must never publish anything and must never
// describe an unpublished version in a Release.
//
// Everything here runs offline. The registry lookup is injected -- as a
// function at the library level, as an executable at the script level
// (DG_NPM_BIN, the same idea as the action suite's PATH stubs) -- so no
// test in this file can pass or fail because of what npmjs.com happened to
// answer.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import {
  EXACT_SEMVER,
  classifyRelease,
  compareExactSemver,
  parseExactSemver,
  readActionVersionDefault,
} from '../lib/release-kind.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'classify-release-tag.mjs');

const CORE_NAME = '@vaultcompass/dep-guard-core';
const CLI_NAME = '@vaultcompass/dep-guard';

function packagesAt(version, overrides = {}) {
  return [
    { name: CORE_NAME, version: overrides[CORE_NAME] ?? version },
    { name: CLI_NAME, version: overrides[CLI_NAME] ?? version },
  ];
}

// A stand-in action.yml whose description block deliberately contains the
// string "default:" and a version-shaped number in prose. The real file's
// version input carries a long block scalar that names example versions,
// so a parser that just grepped for the first "default:" after "version:"
// would read the prose and be wrong in the direction that matters: it
// would compare the tag against a number nobody ships.
function actionYmlWith(defaultVersion) {
  return [
    'name: dep-guard',
    'inputs:',
    '  version:',
    '    description: |',
    '      The exact version to install, such as `9.9.9`. The default: below',
    '      is the scanner version this action tag shipped with.',
    '    required: false',
    `    default: ${defaultVersion}`,
    '  path:',
    '    description: Path to scan',
    '    required: false',
    '    default: .',
    'runs:',
    '  using: composite',
    '',
  ].join('\n');
}

// A CHANGELOG.md in this repository's own style: "## [0.6.1] - 2026-09-12".
function changelogWith(...versions) {
  return [
    '# Changelog',
    '',
    ...versions.flatMap((version) => [`## [${version}] - 2026-09-12`, '', '- Something changed.', '']),
  ].join('\n');
}

function registryStub(publishedSpecs) {
  const published = new Set(publishedSpecs);
  const calls = [];
  const lookup = (name, version) => {
    calls.push(`${name}@${version}`);
    return published.has(`${name}@${version}`) ? version : null;
  };
  lookup.calls = calls;
  return lookup;
}

// The happy action-only case, spelled out once: packages at 0.6.0 and both
// live on the registry at exactly that version, action.yml's default at
// 0.6.0, a CHANGELOG entry for 0.6.1, tag v0.6.1.
function actionOnlyInputs(overrides = {}) {
  return {
    tagName: 'v0.6.1',
    refDescription: 'tag v0.6.1',
    packages: packagesAt('0.6.0'),
    actionYmlText: actionYmlWith('0.6.0'),
    changelogText: changelogWith('0.6.1', '0.6.0'),
    publishedVersion: registryStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]),
    ...overrides,
  };
}

describe('parseExactSemver', () => {
  it('accepts an exact three-part version with no leading zeros', () => {
    expect(parseExactSemver('0.6.0')).toEqual([0, 6, 0]);
    expect(parseExactSemver('10.20.30')).toEqual([10, 20, 30]);
  });

  it('rejects prerelease and build suffixes, leading zeros, and short forms', () => {
    for (const bad of ['0.6.1-rc.1', '0.6.1+build.5', '01.2.3', '0.6.00', '0.6', 'v0.6.1', '', 'latest']) {
      expect(parseExactSemver(bad)).toBeNull();
    }
  });

  it('uses the same shape action.yml validates its version input against', () => {
    // The action refuses anything this pattern does not admit, so a tag
    // the action could not be pinned to is not a tag this repo should
    // treat as an action release.
    expect(EXACT_SEMVER.source).toBe('^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$');
  });
});

describe('compareExactSemver', () => {
  it('orders by number, not by string', () => {
    // The string comparison bash would have done reads "0.10.0" as less
    // than "0.9.0". This is the one place that difference decides whether
    // a tag is a forward move or a mistake.
    expect(compareExactSemver([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0);
    expect(compareExactSemver([0, 6, 1], [0, 6, 0])).toBeGreaterThan(0);
    expect(compareExactSemver([0, 6, 0], [0, 6, 1])).toBeLessThan(0);
    expect(compareExactSemver([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
    expect(compareExactSemver([0, 6, 0], [0, 6, 0])).toBe(0);
  });
});

describe('readActionVersionDefault', () => {
  it('reads the version input default, not a version-shaped string in its prose', () => {
    expect(readActionVersionDefault(actionYmlWith('0.6.0'))).toBe('0.6.0');
  });

  it('is not confused by a later input that also has a default', () => {
    expect(readActionVersionDefault(actionYmlWith('1.2.3'))).toBe('1.2.3');
  });

  it('throws when there is no version input to read', () => {
    const yml = ['inputs:', '  path:', '    default: .', ''].join('\n');
    expect(() => readActionVersionDefault(yml)).toThrow(/version/i);
  });

  it('throws when the version input has no default', () => {
    const yml = ['inputs:', '  version:', '    required: true', '  path:', '    default: .', ''].join('\n');
    expect(() => readActionVersionDefault(yml)).toThrow(/default/i);
  });

  it('throws when there is no inputs block at all', () => {
    const yml = ['name: dep-guard', 'runs:', '  using: composite', ''].join('\n');
    expect(() => readActionVersionDefault(yml)).toThrow(/inputs/i);
  });

  it('reads the version input, not a same-named key in another top-level block', () => {
    // "version" is a plausible key outside inputs -- an outputs block is
    // the obvious one -- and putting it FIRST is what catches a reader
    // that takes the first "  version:" in the file. The number it would
    // pick up here is not what the action installs, so the check it
    // feeds would be comparing the tag against nothing meaningful.
    const yml = [
      'name: dep-guard',
      'outputs:',
      '  version:',
      '    description: The version that ran',
      '    default: 9.9.9',
      'inputs:',
      '  version:',
      '    description: The version to install',
      '    required: false',
      '    default: 0.6.0',
      'runs:',
      '  using: composite',
      '',
    ].join('\n');
    expect(readActionVersionDefault(yml)).toBe('0.6.0');
  });

  it('throws rather than choosing when the version input has two defaults', () => {
    // YAML would resolve a duplicate key silently by taking the last one.
    // A release gate does not get to answer a question the file gives two
    // answers to.
    const yml = [
      'inputs:',
      '  version:',
      '    required: false',
      '    default: 0.6.0',
      '    default: 0.7.0',
      '  path:',
      '    default: .',
      'runs:',
      '  using: composite',
      '',
    ].join('\n');
    expect(() => readActionVersionDefault(yml)).toThrow(/two|2 `default:`|ambiguous/i);
  });

  it('reads the real action.yml and finds an exact semver default', () => {
    // Keeps the parser honest against the file it actually has to parse.
    // Asserting the shape rather than the literal number on purpose: the
    // number moves every scanner release, and a test that has to be
    // edited on every release gets edited without being read.
    const real = readActionVersionDefault(readFileSync(path.join(ROOT, 'action.yml'), 'utf8'));
    expect(real).toMatch(EXACT_SEMVER);
  });
});

// The other half of that canary. The CHANGELOG condition is a pattern
// match against a heading style nothing enforces, so the way it breaks is
// silent: somebody reformats the headings, every test above keeps passing
// against its own synthetic changelog, and the next action-only tag is
// refused at tag time for a release that was perfectly fine. Reading the
// real file here moves that discovery to the pull request that reformats
// it.
describe('the real CHANGELOG.md', () => {
  it('carries a heading the action-only check can find for the current package version', () => {
    const version = JSON.parse(
      readFileSync(path.join(ROOT, 'packages', 'core', 'package.json'), 'utf8')
    ).version;
    const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

    // The same check classifyRelease does, against the version the
    // packages actually carry rather than a number written down here: a
    // trimmed line starting with the literal "## [" + version + "]", no
    // regex built from the version string at all.
    const hasHeading = changelog.split('\n').some((line) => line.trim().startsWith(`## [${version}]`));
    expect(hasHeading).toBe(true);
  });
});

describe('classifyRelease', () => {
  it('calls a tag that equals v plus the package version a package release', () => {
    const publishedVersion = registryStub([]);
    const result = classifyRelease({
      ...actionOnlyInputs(),
      tagName: 'v0.6.0',
      refDescription: 'tag v0.6.0',
      publishedVersion,
    });

    expect(result.actionOnly).toBe(false);
    expect(result.scannerVersion).toBe('0.6.0');
    // The package path must behave exactly as it did before this feature
    // existed, which includes touching the registry not at all: a package
    // release publishes a version that is by definition NOT on the
    // registry yet.
    expect(publishedVersion.calls).toEqual([]);
  });

  it('calls a greater tag with both packages published and the action default in step an action-only release', () => {
    const inputs = actionOnlyInputs();
    const result = classifyRelease(inputs);

    expect(result.actionOnly).toBe(true);
    // The Release body names the scanner the tag installs; it is the
    // published package version, never the tag.
    expect(result.scannerVersion).toBe('0.6.0');
    expect([...inputs.publishedVersion.calls].sort()).toEqual([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`].sort());
  });

  it('fails when the tag is below the package version', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.5.9', refDescription: 'tag v0.5.9' }))
    ).toThrow(/greater/i);
  });

  it('fails when the tag is numerically below the package version but above it as a string', () => {
    // 0.9.0 sorts after 0.10.0 as text. If the comparison were textual
    // this tag would be accepted as a forward move onto an older line.
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: 'v0.9.0',
          refDescription: 'tag v0.9.0',
          packages: packagesAt('0.10.0'),
          actionYmlText: actionYmlWith('0.10.0'),
          publishedVersion: registryStub([`${CORE_NAME}@0.10.0`, `${CLI_NAME}@0.10.0`]),
        })
      )
    ).toThrow(/greater/i);
  });

  it('fails on a tag with a prerelease suffix', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.6.1-rc.1', refDescription: 'tag v0.6.1-rc.1' }))
    ).toThrow(/exact semver/i);
  });

  it('fails on a tag with a build suffix', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.6.1+build.5', refDescription: 'tag v0.6.1+build.5' }))
    ).toThrow(/exact semver/i);
  });

  it('fails on a tag with a leading-zero component', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.06.1', refDescription: 'tag v0.06.1' }))
    ).toThrow(/exact semver/i);
  });

  it('fails on a tag that does not begin with v', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: '0.6.1', refDescription: 'tag 0.6.1' }))
    ).toThrow(/exact semver/i);
  });

  it('fails when core is not on the registry at the package version', () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({ publishedVersion: registryStub([`${CLI_NAME}@0.6.0`]) })
      )
    ).toThrow(new RegExp(CORE_NAME.replace('/', '\\/')));
  });

  it('fails when the cli is not on the registry at the package version', () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({ publishedVersion: registryStub([`${CORE_NAME}@0.6.0`]) })
      )
    ).toThrow(/registry/i);
  });

  it('fails when the registry answers with a different version than it was asked for', () => {
    const publishedVersion = () => '0.5.0';
    expect(() => classifyRelease(actionOnlyInputs({ publishedVersion }))).toThrow(/registry/i);
  });

  it("fails when action.yml's version default is not the package version", () => {
    // The tag is allowed to move without the scanner. The default is not:
    // an action-only tag ships the scanner that is already published, so a
    // moved default means the scanner changed and this is a package
    // release that forgot to bump its packages.
    expect(() =>
      classifyRelease(actionOnlyInputs({ actionYmlText: actionYmlWith('0.6.1') }))
    ).toThrow(/action\.yml/i);
  });

  it('fails a PACKAGE release whose action.yml default is not the version being published', () => {
    // The symmetric half of the action-only default check, and the one
    // that closes the split in the direction nobody chooses on purpose:
    // publishing 0.7.0 under tag v0.7.0 while the action that tag ships
    // still installs 0.6.0.
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: 'v0.7.0',
          refDescription: 'tag v0.7.0',
          packages: packagesAt('0.7.0'),
          actionYmlText: actionYmlWith('0.6.0'),
        })
      )
    ).toThrow(/different scanner than it publishes/i);
  });

  it('accepts a package release whose action.yml default matches', () => {
    const result = classifyRelease(
      actionOnlyInputs({
        tagName: 'v0.7.0',
        refDescription: 'tag v0.7.0',
        packages: packagesAt('0.7.0'),
        actionYmlText: actionYmlWith('0.7.0'),
      })
    );
    expect(result).toEqual({ actionOnly: false, scannerVersion: '0.7.0' });
  });

  it('skips the default check for a prerelease package version, which the action cannot be pinned to', () => {
    // action.yml refuses a prerelease pin outright, so there is no value
    // its default could carry that would equal 0.7.0-rc.1. Requiring one
    // would make a prerelease package release impossible rather than safe.
    const result = classifyRelease(
      actionOnlyInputs({
        tagName: 'v0.7.0-rc.1',
        refDescription: 'tag v0.7.0-rc.1',
        packages: packagesAt('0.7.0-rc.1'),
        actionYmlText: actionYmlWith('0.6.0'),
      })
    );
    expect(result).toEqual({ actionOnly: false, scannerVersion: '0.7.0-rc.1' });
  });

  it('checks the action.yml default on a dispatch run too', () => {
    // A dispatch run publishes and cuts a Release tagged v plus the
    // package version, so the same split is reachable without a tag push.
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: null,
          refDescription: 'branch main (not a tag push)',
          actionYmlText: actionYmlWith('0.5.0'),
        })
      )
    ).toThrow(/different scanner than it publishes/i);
  });

  it('fails an action-only tag with no CHANGELOG entry for its version', () => {
    // The stray-tag case every other condition lets through: packages
    // left at 0.6.0 and "v0.7.0" pushed in the belief that they had
    // moved. Exact semver, greater, published, default in step -- and
    // nobody wrote it down, because nobody decided to release it.
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: 'v0.7.0',
          refDescription: 'tag v0.7.0',
          changelogText: changelogWith('0.6.1', '0.6.0'),
        })
      )
    ).toThrow(/CHANGELOG\.md/);
  });

  it('accepts an action-only tag whose version has a CHANGELOG entry', () => {
    const result = classifyRelease(
      actionOnlyInputs({
        tagName: 'v0.7.0',
        refDescription: 'tag v0.7.0',
        changelogText: changelogWith('0.7.0', '0.6.1'),
      })
    );
    expect(result.actionOnly).toBe(true);
  });

  it('fails an action-only tag when CHANGELOG.md could not be read at all', () => {
    expect(() => classifyRelease(actionOnlyInputs({ changelogText: null }))).toThrow(/CHANGELOG\.md/);
  });

  it('checks the CHANGELOG before it touches the registry', () => {
    // Local, on the tagged commit's own tree, and free. A stray tag
    // should not cost a registry round trip to reject.
    const publishedVersion = registryStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]);
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: 'v0.7.0',
          refDescription: 'tag v0.7.0',
          changelogText: changelogWith('0.6.0'),
          publishedVersion,
        })
      )
    ).toThrow(/CHANGELOG\.md/);
    expect(publishedVersion.calls).toEqual([]);
  });

  it('fails when core and cli versions disagree, before anything else is considered', () => {
    const publishedVersion = registryStub([]);
    expect(() =>
      classifyRelease(actionOnlyInputs({ packages: packagesAt('0.6.0', { [CLI_NAME]: '0.5.0' }), publishedVersion }))
    ).toThrow(/lockstep/i);
    expect(publishedVersion.calls).toEqual([]);
  });

  it('never consults the registry when there is no tag at all', () => {
    // workflow_dispatch: GITHUB_REF_TYPE is "branch", there is no tag to
    // classify, and the branch guard earlier in the job is what keeps the
    // run on main. Lockstep and the action.yml default are checked (see
    // the dispatch case above); the registry is not, because a dispatch
    // run is a package release and publishes a version that should not be
    // there yet.
    const publishedVersion = registryStub([]);
    const result = classifyRelease({
      ...actionOnlyInputs(),
      tagName: null,
      refDescription: 'branch main (not a tag push)',
      publishedVersion,
    });
    expect(result.actionOnly).toBe(false);
    expect(publishedVersion.calls).toEqual([]);

    expect(() =>
      classifyRelease({
        ...actionOnlyInputs(),
        tagName: null,
        refDescription: 'branch main (not a tag push)',
        packages: packagesAt('0.6.0', { [CLI_NAME]: '0.5.0' }),
      })
    ).toThrow(/lockstep/i);
  });

  it('fails legibly when the package version itself is not exact semver and the tag differs', () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          packages: packagesAt('0.6.0-rc.1'),
          actionYmlText: actionYmlWith('0.6.0'),
        })
      )
    ).toThrow(/package version/i);
  });

  it('names the ref in every failure message', () => {
    // The whole point of failing here rather than at publish time is that
    // a human reads the message at tag time. A message that does not name
    // the tag makes them go look it up.
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.5.9', refDescription: 'tag v0.5.9' }))
    ).toThrow(/tag v0\.5\.9/);
  });

  it('requires at least one package', () => {
    expect(() =>
      classifyRelease({
        tagName: null,
        refDescription: 'branch main (not a tag push)',
        packages: [],
        actionYmlText: actionYmlWith('0.6.0'),
        changelogText: changelogWith('0.6.0'),
        publishedVersion: registryStub([]),
      })
    ).toThrow(/at least one package/i);
  });

  it('accepts the vault-guard packages[] shape for the current two-package layout', () => {
    const result = classifyRelease({
      tagName: 'v0.6.1',
      refDescription: 'tag v0.6.1',
      packages: [
        { name: CORE_NAME, version: '0.6.0' },
        { name: CLI_NAME, version: '0.6.0' },
      ],
      actionYmlText: actionYmlWith('0.6.0'),
      changelogText: changelogWith('0.6.1', '0.6.0'),
      publishedVersion: registryStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]),
    });
    expect(result.actionOnly).toBe(true);
    expect(result.scannerVersion).toBe('0.6.0');
  });

  it('accepts a single-package packages[] the same way it accepts two', () => {
    const result = classifyRelease({
      tagName: 'v0.6.1',
      refDescription: 'tag v0.6.1',
      packages: [{ name: CORE_NAME, version: '0.6.0' }],
      actionYmlText: actionYmlWith('0.6.0'),
      changelogText: changelogWith('0.6.1', '0.6.0'),
      publishedVersion: registryStub([`${CORE_NAME}@0.6.0`]),
    });
    expect(result.actionOnly).toBe(true);
    expect(result.scannerVersion).toBe('0.6.0');
  });

  it('does not treat a longer heading as a match for a shorter version', () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          changelogText: changelogWith('0.6.10', '0.6.0'),
        })
      )
    ).toThrow(/CHANGELOG\.md/);
    expect(
      classifyRelease(actionOnlyInputs({ changelogText: changelogWith('0.6.1', '0.6.0') })).actionOnly,
    ).toBe(true);
  });
});

// The workflow half. The library above can be perfectly correct while
// .github/workflows/release.yml ignores its answer, and the failure that
// would produce is the expensive one: a publish on a tag that was supposed
// to publish nothing, or a Release page announcing a publish that did not
// happen. Nothing here re-tests the decision -- it tests that the decision
// is wired to the steps it is supposed to govern.
//
// Textual rather than through a YAML parser on purpose: this repository
// has no YAML dependency, and the release job's decision step runs before
// `pnpm install` precisely so it depends on nothing.
describe('.github/workflows/release.yml wiring', () => {
  // DG_RELEASE_WORKFLOW points this suite at a mutated copy, the same
  // override and the same reason as DG_ACTION_FILE in the action suites:
  // a guard nobody has watched fail is a guard nobody knows works. Used to
  // confirm that dropping the gate from "Publish to npm" turns this file
  // red, which is not something that can be tried on the real file.
  const workflow = readFileSync(
    process.env.DG_RELEASE_WORKFLOW ?? path.join(ROOT, '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  // Spelled positively, and asserted as this exact string. "!= 'true'" is
  // the same thing right up until the output is empty or missing, at
  // which point it publishes on a run that decided nothing.
  const GATE = "steps.kind.outputs.action_only == 'false'";

  // prepare's steps sit at four spaces. The publish job's steps sit at
  // six, and so do the smoke job's, so each job is sliced out before it
  // is parsed. A parser that walked the whole file at one indent would
  // either miss the publish job or mix it with smoke.
  //
  // A step is identified by its name, or by "uses:<value>" when it has no
  // name -- a step written "- uses: actions/checkout@..." with no name is
  // valid YAML and perfectly ordinary, and a parser that only knew
  // "- name:" would not see it at all. That blindness is exactly what an
  // exact-list assertion must not have: an unnamed publish-side step
  // would then be invisible to every check below rather than caught by
  // them.
  function parseSteps(text, indent = 4) {
    const lines = text.split('\n');
    const steps = [];
    let current = null;
    const nameRe = new RegExp(`^ {${indent}}- name: (.*)$`);
    const usesRe = new RegExp(`^ {${indent}}- uses: (.*)$`);
    const ifRe = new RegExp(`^ {${indent + 2}}if: (.*)$`);
    const usesLaterRe = new RegExp(`^ {${indent + 2}}uses: (.*)$`);
    const endStepRe = new RegExp(`^ {${indent - 2}}\\S`);
    for (const line of lines) {
      const nameMatch = nameRe.exec(line);
      const usesMatch = usesRe.exec(line);
      if (nameMatch !== null || usesMatch !== null) {
        current = {
          name: nameMatch === null ? null : nameMatch[1].trim(),
          uses: usesMatch === null ? null : usesMatch[1].trim(),
          if: null,
        };
        current.id = current.name ?? `uses:${current.uses}`;
        steps.push(current);
        continue;
      }
      if (current !== null) {
        const ifMatch = ifRe.exec(line);
        if (ifMatch !== null) {
          current.if = ifMatch[1].trim();
        }
        const usesLater = usesLaterRe.exec(line);
        if (usesLater !== null && current.uses === null) {
          current.uses = usesLater[1].trim();
        }
        if (endStepRe.test(line)) {
          current = null;
        }
      }
    }
    return steps;
  }

  const prepareText = workflow.slice(workflow.indexOf('\n  prepare:'), workflow.indexOf('\n  release:'));
  const publishText = workflow.slice(workflow.indexOf('\n  release:'), workflow.indexOf('\n  smoke-published:'));
  const releaseJobSteps = () => parseSteps(prepareText, 4);
  const publishJobSteps = () => parseSteps(publishText, 6);
  // The publish job cannot read steps.kind. Its gate is the output prepare
  // forwarded, spelled the same positive way.
  const PUBLISH_GATE = "needs.prepare.outputs.action_only == 'false'";

  // Every step that exists to protect or perform a publish, in the order
  // the workflow runs them. The gates (build, typecheck, lint, test) are
  // NOT here: they run on both kinds of release, because the ancestry
  // check proves the tagged commit is an ancestor of main, not that CI
  // ran on it, and an action-only release's payload is exactly what lint
  // and the action suites cover.
  const GATED_STEPS = [
    'Build the shipped corpus',
    'Check the corpus is fit to publish',
    'Check the corpus reaches the packed tarball',
    'Install the packed tarballs and run the shipped binary',
    'Pack the publishable tarballs',
    'Check the packed tarballs match their packages',
    'Upload the packed tarballs',
  ];

  // Every step in the job that holds id-token, in order. Checkout and
  // Node setup run for both kinds of release, because both still cut a
  // GitHub Release. Everything that publishes or announces a publish is
  // gated.
  const PUBLISH_JOB_STEPS = [
    'Checkout',
    'Setup Node.js',
    'Upgrade npm for OIDC trusted publishing',
    'Download the packed tarballs',
    'Publish to npm',
    'Create GitHub Release',
    'Create GitHub Release (action-only)',
  ];

  // Every step from the decision to the end of the prepare job, gated or
  // not, in order. The set assertion below cannot see a NEW ungated step.
  // That is what this list is for: inserting anything after the decision,
  // named or unnamed, fails until somebody states which side of the gate
  // it belongs on. The publish job has its own list, for the same reason:
  // a step added there is past this job, and it is the job that holds the
  // token.
  const STEPS_AFTER_DECISION = [
    'Install dependencies',
    'Build packages',
    'Typecheck',
    'Lint (public repository hygiene guard)',
    'Run tests',
    ...GATED_STEPS,
    'Resolve release tag',
  ];

  it('gates exactly the publish-side steps on the decision step output', () => {
    const gated = releaseJobSteps()
      .filter((step) => step.if === GATE)
      .map((step) => step.id);
    expect(gated.sort()).toEqual([...GATED_STEPS].sort());

    const publishGated = publishJobSteps()
      .filter((step) => step.if === PUBLISH_GATE)
      .map((step) => step.id);
    // "Create GitHub Release" carries the same gate and is asserted
    // separately below, with the body claim it guards.
    expect(publishGated.sort()).toEqual(
      [
        'Upgrade npm for OIDC trusted publishing',
        'Download the packed tarballs',
        'Publish to npm',
        'Create GitHub Release',
      ].sort()
    );
  });

  it('runs the code gates on both kinds of release', () => {
    const ungated = ['Install dependencies', 'Build packages', 'Typecheck', 'Lint (public repository hygiene guard)', 'Run tests'];
    for (const name of ungated) {
      const step = releaseJobSteps().find((s) => s.id === name);
      expect(step).toBeDefined();
      expect(step.if).toBeNull();
    }
  });

  it('accounts for every step after the decision, to the end of the job, in order', () => {
    const ids = releaseJobSteps().map((step) => step.id);
    const from = ids.indexOf('Decide the release kind, and refuse a tag that is neither');
    expect(from).toBeGreaterThan(-1);
    expect(ids.slice(from + 1)).toEqual(STEPS_AFTER_DECISION);
    expect(publishJobSteps().map((step) => step.id)).toEqual(PUBLISH_JOB_STEPS);
  });

  it('sees a step written as bare `- uses:` with no name', () => {
    // Every step in the real file happens to be named, so the fallback is
    // exercised here against a synthetic job instead. Without it, an
    // unnamed step inserted on the publish side would be invisible to the
    // ordered list above rather than caught by it -- the list would still
    // match, and the step would still run.
    const synthetic = [
      'jobs:',
      '  release:',
      '    steps:',
      '    - name: Decide the release kind, and refuse a tag that is neither',
      '      id: kind',
      '    - uses: some/action@v1',
      '    - name: Resolve release tag',
      '',
    ].join('\n');

    expect(parseSteps(synthetic).map((step) => step.id)).toEqual([
      'Decide the release kind, and refuse a tag that is neither',
      'uses:some/action@v1',
      'Resolve release tag',
    ]);
  });

  it('leaves tag resolution ungated, since both kinds of release cut a Release', () => {
    const resolve = releaseJobSteps().find((step) => step.id === 'Resolve release tag');
    expect(resolve).toBeDefined();
    expect(resolve.if).toBeNull();
  });

  it('claims a publish only on the path that performs one', () => {
    // "Published ... to npm" must live in exactly one Release body, and
    // that body's step must carry the same gate as the publish step. An
    // action-only release that announced a publish would be sending
    // people to look for a version that does not exist.
    const publishClaims = workflow.match(/Published `@vaultcompass\/dep-guard`/g) ?? [];
    expect(publishClaims).toHaveLength(1);

    const release = publishJobSteps().find((step) => step.id === 'Create GitHub Release');
    expect(release.if).toBe(PUBLISH_GATE);

    const actionOnlyRelease = publishJobSteps().find(
      (step) => step.id === 'Create GitHub Release (action-only)'
    );
    expect(actionOnlyRelease.if).toBe("needs.prepare.outputs.action_only == 'true'");
    expect(workflow).toContain('Nothing was published to npm by this release.');
    expect(workflow).toContain('CHANGELOG.md');
  });

  it('skips the published-CLI smoke job when nothing was published', () => {
    // Positive spelling here too: an empty output means no run decided
    // anything, and the smoke job's whole premise is that a publish
    // happened.
    expect(workflow).toContain("if: needs.release.outputs.action_only == 'false'");
    expect(workflow).toContain('action_only: ${{ steps.kind.outputs.action_only }}');
  });

  it('never gates anything on the negative spelling', () => {
    // The one assertion that would catch a well-meaning edit back to
    // "!= 'true'", which reads identically and fails open.
    expect(workflow).not.toContain("action_only != 'true'");
    expect(workflow).not.toContain("action_only != 'false'");
  });

  it('passes the changelog to the decision script on both invocations', () => {
    const invocations = workflow.match(/node scripts\/classify-release-tag\.mjs/g) ?? [];
    expect(invocations).toHaveLength(2);
    const changelogArgs = workflow.match(/--changelog CHANGELOG\.md/g) ?? [];
    expect(changelogArgs).toHaveLength(2);
  });

  it('passes both published packages to the decision script', () => {
    for (const dir of ['core', 'cli']) {
      expect(workflow).toContain(`require('./packages/${dir}/package.json').name`);
      expect(workflow).toContain(`require('./packages/${dir}/package.json').version`);
    }
    const packageFlags = workflow.match(/--package "/g) ?? [];
    // Two packages, two invocations (tag push and workflow_dispatch).
    expect(packageFlags).toHaveLength(4);
    expect(workflow).toContain('--package "${CORE_NAME}=${CORE_VERSION}"');
    expect(workflow).toContain('--package "${CLI_NAME}=${CLI_VERSION}"');
  });

  it('keeps the decision step and the "Publish to npm" loop in the same set of packages', () => {
    const decisionDirs = [...workflow.matchAll(/require\('\.\/packages\/([a-z0-9_-]+)\/package\.json'\)\.name/g)].map(
      (match) => match[1]
    );
    expect(decisionDirs.length).toBeGreaterThan(0);

    const publishDirs = [...workflow.matchAll(/^ {10}publish_one packages\/([a-z0-9_-]+) /gm)].map(
      (match) => match[1]
    );
    expect(publishDirs.length).toBeGreaterThan(0);

    expect(new Set(publishDirs)).toEqual(new Set(decisionDirs));
  });

  // The text of one prepare step, from its "- name:" line to the next step.
  function prepareStepText(name) {
    const start = prepareText.indexOf(`\n    - name: ${name}\n`);
    expect(start).toBeGreaterThan(-1);
    const next = prepareText.indexOf('\n    - ', start + 1);
    return prepareText.slice(start, next === -1 ? undefined : next);
  }

  it('packs each published package by directory, into an absolute destination', () => {
    // On pnpm 9, the version packageManager pins, "pnpm --filter <name>
    // pack" in this workspace exits 1 with "Unknown option: 'recursive'",
    // so a filter-based pack step dies on every package tag before
    // anything reaches npm. With --dir, a relative destination lands under
    // the package directory rather than where the upload step looks.
    const pack = prepareStepText('Pack the publishable tarballs');
    expect(pack).not.toContain('--filter');
    const order = ['core', 'cli'].map((dir) => {
      const command = `pnpm --dir packages/${dir} pack --pack-destination "\${GITHUB_WORKSPACE}/pack-out/${dir}"`;
      expect(pack).toContain(command);
      return pack.indexOf(command);
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('checks every packed tarball against the package it was packed from', () => {
    const check = prepareStepText('Check the packed tarballs match their packages');
    expect(check).toContain('set -euo pipefail');
    expect(check).toContain('for dir in core cli; do');
    expect(check).toContain('package/package.json');
    expect(check).toContain("require('./packages/${dir}/package.json')");
    expect(check).toContain('::error::');
  });

  it('keeps the publish token off the job that installs dependencies', () => {
    expect(prepareText).not.toMatch(/^ {6}id-token:/m);
    expect(publishText).toMatch(/^ {6}id-token: write$/m);
    expect(publishText).toContain('needs: prepare');
  });

  it('calls the decision script from a step with the id the conditions read', () => {
    expect(workflow).toMatch(/^ {4}- name: Decide the release kind[^\n]*\n {6}id: kind$/m);
    expect(workflow).toContain('node scripts/classify-release-tag.mjs');
    // The ancestry check stays in bash, next to the git fetches it needs,
    // and stays outside the package-release branch: it applies to both
    // kinds of tag.
    expect(workflow).toContain('git merge-base --is-ancestor');
  });
});

// The script half: argument handling, the real spawn of an npm-shaped
// executable, and the GITHUB_OUTPUT contract the workflow's later steps
// read. DG_NPM_BIN points at a stub here, so this never reaches the
// network -- and the stub records what it was asked, so "the package path
// does not consult the registry" is proven against the real spawn path and
// not only against the injected function above.
describe('classify-release-tag.mjs', () => {
  function makeNpmStub(publishedSpecs) {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-npm-stub-'));
    const bin = path.join(dir, 'npm-stub.mjs');
    const log = path.join(dir, 'calls.log');
    const source = [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `const published = ${JSON.stringify(publishedSpecs)};`,
      // Logs the working directory it was started in as well as its
      // arguments: where npm runs decides which .npmrc it reads, and that
      // decides what "already published" means.
      `appendFileSync(${JSON.stringify(log)}, 'cwd=' + process.cwd() + ' argv=' + process.argv.slice(2).join(' ') + '\\n');`,
      "const spec = process.argv[3] ?? '';",
      'if (!published.includes(spec)) {',
      "  process.stderr.write('npm error code E404\\n');",
      '  process.exit(1);',
      '}',
      "process.stdout.write(spec.slice(spec.lastIndexOf('@') + 1) + '\\n');",
      '',
    ].join('\n');
    writeFileSync(bin, source);
    chmodSync(bin, 0o755);
    writeFileSync(log, '');
    return { bin, log, dir };
  }

  function run(args, env) {
    const outFile = path.join(mkdtempSync(path.join(tmpdir(), 'dg-gh-out-')), 'output.txt');
    // Actions creates this file before the step runs and the script only
    // ever appends, so the harness creates it too. Reading it back has to
    // work on the failure paths as well: "the run failed AND wrote no
    // action_only=true" is one of the things being asserted.
    writeFileSync(outFile, '');
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
    });
    return { ...result, outputs: readFileSync(outFile, 'utf8') };
  }

  const baseArgs = (tag) => [
    ...(tag === null ? [] : ['--tag', tag]),
    '--package',
    `${CORE_NAME}=0.6.0`,
    '--package',
    `${CLI_NAME}=0.6.0`,
  ];

  function withActionYml(defaultVersion) {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-action-yml-'));
    const file = path.join(dir, 'action.yml');
    writeFileSync(file, actionYmlWith(defaultVersion));
    return file;
  }

  function withChangelog(...versions) {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-changelog-'));
    const file = path.join(dir, 'CHANGELOG.md');
    writeFileSync(file, changelogWith(...versions));
    return file;
  }

  // The files every case below needs unless it is testing one of them: an
  // action.yml whose default matches the package version, and a CHANGELOG
  // carrying an entry for the action-only tag these tests push.
  const files = (actionDefault = '0.6.0', changelogVersions = ['0.6.1', '0.6.0']) => [
    '--action-yml',
    withActionYml(actionDefault),
    '--changelog',
    withChangelog(...changelogVersions),
  ];

  it('reports action_only=true and the scanner version for a valid action-only tag', () => {
    const stub = makeNpmStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]);
    const result = run([...baseArgs('v0.6.1'), ...files()], {
      DG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain('action_only=true');
    expect(result.outputs).toContain('scanner_version=0.6.0');
    expect(readFileSync(stub.log, 'utf8')).toContain(`view ${CORE_NAME}@0.6.0 version`);
  });

  it('asks the public registry, from a directory this repository does not control', () => {
    // npm reads .npmrc from its working directory upward, so running the
    // lookup at the repository root would let a checked-in or generated
    // .npmrc decide what "already published" means -- the one question
    // standing between a tag and a Release page claiming a published
    // version. Hence a temp directory, and an explicit --registry.
    const stub = makeNpmStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]);
    const result = run([...baseArgs('v0.6.1'), ...files()], { DG_NPM_BIN: stub.bin });
    expect(result.status).toBe(0);

    const log = readFileSync(stub.log, 'utf8');
    const cwds = [...log.matchAll(/^cwd=(.*?) argv=/gm)].map((m) => m[1]);
    expect(cwds.length).toBeGreaterThan(0);
    for (const cwd of cwds) {
      expect(cwd).not.toBe(ROOT);
      expect(cwd.startsWith(ROOT)).toBe(false);
    }
    expect(log).toContain('--registry=https://registry.npmjs.org');
  });

  it('runs the lookup in RUNNER_TEMP when the runner provides one', () => {
    const runnerTemp = mkdtempSync(path.join(tmpdir(), 'dg-runner-temp-'));
    const stub = makeNpmStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]);
    const result = run([...baseArgs('v0.6.1'), ...files()], {
      DG_NPM_BIN: stub.bin,
      RUNNER_TEMP: runnerTemp,
    });

    expect(result.status).toBe(0);
    // realpath: the OS temp dir resolves through a symlink on macOS, so
    // the child reports the resolved path for the value handed in here.
    expect(readFileSync(stub.log, 'utf8')).toContain(`cwd=${realpathSync(runnerTemp)} `);
  });

  it('refuses an action-only tag whose version has no CHANGELOG entry', () => {
    const stub = makeNpmStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]);
    const result = run([...baseArgs('v0.6.1'), ...files('0.6.0', ['0.6.0'])], {
      DG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('CHANGELOG.md');
    expect(result.outputs).not.toContain('action_only=true');
  });

  it('reports action_only=false for a package-release tag and never runs npm', () => {
    const stub = makeNpmStub([]);
    const result = run([...baseArgs('v0.6.0'), ...files()], {
      DG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain('action_only=false');
    expect(readFileSync(stub.log, 'utf8')).toBe('');
  });

  it('refuses a package-release tag whose action.yml default is a different version', () => {
    const stub = makeNpmStub([]);
    const result = run([...baseArgs('v0.6.0'), ...files('0.5.0')], { DG_NPM_BIN: stub.bin });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('different scanner than it publishes');
    expect(readFileSync(stub.log, 'utf8')).toBe('');
  });

  it('exits 1 with a workflow error annotation when the packages are not published', () => {
    const stub = makeNpmStub([]);
    const result = run([...baseArgs('v0.6.1'), ...files()], {
      DG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('::error::');
    expect(result.stdout + result.stderr).toContain(CORE_NAME);
    expect(result.outputs).not.toContain('action_only=true');
  });

  it('exits 1 when a required argument is missing', () => {
    const result = run(['--tag', 'v0.6.1'], {});
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/--package/);
  });

  it('accepts --package name=version the same way vault-guard does', () => {
    const stub = makeNpmStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]);
    const result = run(
      [
        '--tag',
        'v0.6.1',
        '--package',
        `${CORE_NAME}=0.6.0`,
        '--package',
        `${CLI_NAME}=0.6.0`,
        ...files(),
      ],
      { DG_NPM_BIN: stub.bin }
    );
    expect(result.status).toBe(0);
    expect(result.outputs).toContain('action_only=true');
    expect(result.outputs).toContain('scanner_version=0.6.0');
  });

  it('exits 1 when a --package value is not name=version', () => {
    const result = run(['--tag', 'v0.6.1', '--package', 'not-a-valid-value'], {});
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/name=version/);
  });

  it('treats an npm lookup that fails for any reason as not published', () => {
    // Fail closed. A registry outage blocks an action-only tag; it must
    // never be read as "published, go ahead".
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-npm-broken-'));
    const bin = path.join(dir, 'npm-broken');
    writeFileSync(bin, '#!/bin/sh\nexit 7\n');
    chmodSync(bin, 0o755);

    const result = run([...baseArgs('v0.6.1'), ...files()], {
      DG_NPM_BIN: bin,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('::error::');
  });
});
