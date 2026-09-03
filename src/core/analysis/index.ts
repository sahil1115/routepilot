export { TaskClassifier, type ClassificationInput } from './task-classifier.js';
export {
  RepositoryAnalyzer,
  type AnalysisRequest,
  type RepositoryAnalyzerOptions,
} from './repository-analyzer.js';
export { FeatureExtractor, type FeatureExtractionInput } from './feature-extractor.js';
export { AnalysisCache, type CachedAnalysis, type CacheStatistics } from './cache.js';
export {
  computeFingerprint,
  diffFingerprints,
  type FingerprintDiff,
  type RepositoryFingerprint,
} from './fingerprint.js';
export {
  estimateOutputTokens,
  estimateTokens,
  estimateTokensFromBytes,
  withSafetyMargin,
} from './tokens.js';
export {
  detectFrameworks,
  detectLanguage,
  detectPackageManager,
  detectTestFrameworks,
  isSourceLanguage,
  isTestPath,
} from './languages.js';
