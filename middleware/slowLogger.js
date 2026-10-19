// Logs requests that exceed a threshold to help identify slow endpoints
module.exports = function slowLogger(thresholdMs = 200) {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > thresholdMs) {
        console.warn(`[slow] ${req.method} ${req.originalUrl} took ${duration}ms`);
      }
    });
    next();
  };
};
