import Conditions from './src/conditions';
import PacGenerator from './src/pac_generator';
import Profiles from './src/profiles';
import RuleList from './src/rule_list';
import ShexpUtils from './src/shexp_utils';
import { Revision, AttachedCache, isIp, getBaseDomain, wildcardForDomain, wildcardForUrl } from './src/utils';

const OmegaPac = {
  Conditions,
  PacGenerator,
  Profiles,
  RuleList,
  ShexpUtils,
  Revision,
  AttachedCache,
  isIp,
  getBaseDomain,
  wildcardForDomain,
  wildcardForUrl,
};

module.exports = OmegaPac;
export default OmegaPac;
export { Conditions, PacGenerator, Profiles, RuleList, ShexpUtils, Revision, AttachedCache, isIp, getBaseDomain, wildcardForDomain, wildcardForUrl };
