import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from './rate_limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 60_000);
  });

  describe('consume', () => {
    it('should allow requests up to the token limit', () => {
      expect(limiter.consume('node1')).toBe(0);
      expect(limiter.consume('node1')).toBe(0);
      expect(limiter.consume('node1')).toBe(0);
    });

    it('should rate limit after token exhaustion', () => {
      limiter.consume('node1');
      limiter.consume('node1');
      limiter.consume('node1');
      
      const waitTime = limiter.consume('node1');
      expect(waitTime).toBeGreaterThan(0);
    });

    it('should track each node separately', () => {
      expect(limiter.consume('node1')).toBe(0);
      expect(limiter.consume('node1')).toBe(0);
      expect(limiter.consume('node1')).toBe(0);
      
      expect(limiter.consume('node2')).toBe(0);
    });

    it('should return 0 for new nodes even after other nodes are rate limited', () => {
      limiter.consume('node1');
      limiter.consume('node1');
      limiter.consume('node1');
      
      expect(limiter.consume('node2')).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should remove stale buckets', () => {
      limiter.consume('node1');
      
      limiter.cleanup();
      
      const waitTime = limiter.consume('node1');
      expect(waitTime).toBe(0);
    });
  });

  describe('constructor', () => {
    it('should use default values when not provided', () => {
      const defaultLimiter = new RateLimiter();
      expect(defaultLimiter.consume('test')).toBe(0);
    });

    it('should accept custom maxTokens and refillInterval', () => {
      const custom = new RateLimiter(10, 1000);
      for (let i = 0; i < 10; i++) {
        expect(custom.consume('test')).toBe(0);
      }
      expect(custom.consume('test')).toBeGreaterThan(0);
    });
  });
});
