import { describe, it, expect } from 'vitest';
import { logger, createChildLogger } from './logger.js';

describe('Logger', () => {
  describe('logger', () => {
    it('should be defined', () => {
      expect(logger).toBeDefined();
    });

    it('should have required methods', () => {
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.fatal).toBe('function');
    });
  });

  describe('createChildLogger', () => {
    it('should create a child logger with module name', () => {
      const child = createChildLogger('test-module');
      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
    });
  });
});
