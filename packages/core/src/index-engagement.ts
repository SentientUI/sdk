// Lazy engagement entry — loaded on demand (mirrors ./graph) so the lean
// bundle never carries the section classifier or IntersectionObserver logic.
export { startEngagementCapture, type EngagementCaptureOptions } from './engagement/capture';
export {
  classifyFeatures,
  classifySection,
  featuresFromElement,
  SEMANTIC_TYPES,
  type SectionFeatures,
  type SemanticType,
} from './engagement/classify';
