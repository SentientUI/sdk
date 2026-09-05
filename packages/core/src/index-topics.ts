// SERVER-ONLY entry for the rich section-topic vocabulary.
//
// Separate from ./engagement on purpose: the topic tables cost ~1.5 KB gzip,
// which is 7% of the always-on snippet, on every page view of every customer
// site — and the browser never reads them (classifySection returns only the
// parent). Only the site-audit classification job imports this.
export {
  classifyTopic,
  CLASSIFIER_TOPICS,
  CLASSIFIER_VERSION,
  type TopicRule,
} from './engagement/topics';
export type { SectionFeatures, SemanticType } from './engagement/classify';
