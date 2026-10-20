const getGitHubApiHeaders = () => {
  const token = process.env.GITHUB_TOKEN?.trim();

  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Joblink-Backend',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

module.exports = { getGitHubApiHeaders };
