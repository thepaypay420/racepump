import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  requests: number[];
  lastCleanup: number;
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  maxBetRequests: number;
  maxApiRequests: number;
  cleanupIntervalMs: number;
}

class SmartRateLimiter {
  private ipMap = new Map<string, RateLimitEntry>();
  private config: RateLimitConfig;
  private isProduction: boolean;
  private lastGlobalCleanup: number;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      windowMs: config.windowMs || 60000, // 1 minute default
      maxRequests: config.maxRequests || 300, // 300 requests/min for general traffic
      maxBetRequests: config.maxBetRequests || 30, // 30 bets/min to prevent spam
      maxApiRequests: config.maxApiRequests || 120, // 120 API calls/min
      cleanupIntervalMs: config.cleanupIntervalMs || 300000 // Cleanup every 5 min
    };
    
    // Only enable in production
    this.isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.REPLIT_DEPLOYMENT);
    this.lastGlobalCleanup = Date.now();
    
    if (this.isProduction) {
      console.log('🛡️ Smart rate limiter enabled (production mode)');
      console.log(`   Window: ${this.config.windowMs}ms`);
      console.log(`   Limits: ${this.config.maxRequests} general, ${this.config.maxApiRequests} API, ${this.config.maxBetRequests} bets`);
    } else {
      console.log('🛡️ Rate limiter disabled (development mode)');
    }
  }

  private getClientIp(req: Request): string {
    // Try to get real IP from common proxy headers
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = typeof forwarded === 'string' ? forwarded.split(',') : forwarded;
      return ips[0].trim();
    }
    
    return req.headers['x-real-ip'] as string || 
           req.socket.remoteAddress || 
           'unknown';
  }

  private cleanupOldEntries(entry: RateLimitEntry, now: number): void {
    const cutoff = now - this.config.windowMs;
    entry.requests = entry.requests.filter(timestamp => timestamp > cutoff);
    entry.lastCleanup = now;
  }

  private globalCleanup(): void {
    const now = Date.now();
    if (now - this.lastGlobalCleanup < this.config.cleanupIntervalMs) {
      return;
    }

    const cutoff = now - this.config.windowMs;
    const initialSize = this.ipMap.size;
    
    // Remove IPs with no recent requests
    for (const [ip, entry] of this.ipMap.entries()) {
      if (entry.requests.length === 0 || Math.max(...entry.requests) < cutoff) {
        this.ipMap.delete(ip);
      }
    }
    
    this.lastGlobalCleanup = now;
    
    if (this.ipMap.size < initialSize) {
      console.log(`🧹 Rate limiter cleanup: ${initialSize} → ${this.ipMap.size} IPs tracked`);
    }
  }

  private getLimit(path: string): number {
    // Stricter limits for mutation endpoints
    if (path.startsWith('/api/bets') || path.startsWith('/api/claim')) {
      return this.config.maxBetRequests;
    }
    
    // Medium limits for API endpoints
    if (path.startsWith('/api/')) {
      return this.config.maxApiRequests;
    }
    
    // Loose limits for static assets and pages
    return this.config.maxRequests;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Skip rate limiting in development
      if (!this.isProduction) {
        return next();
      }

      // Skip health checks and SSE connections
      if (req.path === '/api/health' || req.path === '/api/events') {
        return next();
      }

      const now = Date.now();
      const ip = this.getClientIp(req);
      const limit = this.getLimit(req.path);

      // Get or create entry for this IP
      let entry = this.ipMap.get(ip);
      if (!entry) {
        entry = { requests: [], lastCleanup: now };
        this.ipMap.set(ip, entry);
      }

      // Cleanup old requests for this IP
      this.cleanupOldEntries(entry, now);

      // Check if limit exceeded
      if (entry.requests.length >= limit) {
        const oldestRequest = Math.min(...entry.requests);
        const resetTime = oldestRequest + this.config.windowMs;
        const retryAfter = Math.ceil((resetTime - now) / 1000);

        res.setHeader('X-RateLimit-Limit', limit.toString());
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', resetTime.toString());
        res.setHeader('Retry-After', retryAfter.toString());

        return res.status(429).json({
          error: 'Too many requests',
          message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
          retryAfter
        });
      }

      // Add this request
      entry.requests.push(now);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', limit.toString());
      res.setHeader('X-RateLimit-Remaining', (limit - entry.requests.length).toString());
      res.setHeader('X-RateLimit-Reset', (now + this.config.windowMs).toString());

      // Periodic global cleanup
      this.globalCleanup();

      next();
    };
  }

  // Public method to get stats (for monitoring)
  getStats() {
    return {
      enabled: this.isProduction,
      trackedIPs: this.ipMap.size,
      config: this.config
    };
  }
}

// Export singleton instance with production-optimized config
export const rateLimiter = new SmartRateLimiter({
  windowMs: 60000,           // 1 minute window
  maxRequests: 300,          // 300 total requests/min (5 req/sec for static assets)
  maxApiRequests: 120,       // 120 API requests/min (2 req/sec for data)
  maxBetRequests: 30,        // 30 bets/min (1 bet every 2 sec)
  cleanupIntervalMs: 300000  // Cleanup every 5 minutes
});
