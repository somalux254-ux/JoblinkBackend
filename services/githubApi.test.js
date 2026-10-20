const test = require('node:test');
const assert = require('node:assert/strict');
const { getGitHubApiHeaders } = require('./githubApi');

test('GitHub API headers include a configured token without exposing it elsewhere', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';

  try {
    assert.deepEqual(getGitHubApiHeaders(), {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Joblink-Backend',
      Authorization: 'Bearer test-token',
    });
  } finally {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  }
});

test('GitHub API headers remain usable without a configured token', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;

  try {
    assert.deepEqual(getGitHubApiHeaders(), {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Joblink-Backend',
    });
  } finally {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    }
  }
});
