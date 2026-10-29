package scope

import (
	"errors"
	"fmt"
	"net/netip"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/netguard"
)

// ErrLabRule is wrapped, together with ErrInvalidRule, by every private-range rule the lab gate
// refuses (#880). A refused rule set puts nothing in scope.
var ErrLabRule = errors.New("SCOPE_LAB_RULE_DENIED")

// Lab environments in which a private-range rule may ever exist (BW_ENV, #880, CONTEXT_PACK §10).
const (
	EnvDev  = "dev"
	EnvTest = "test"
)

// LabContext is what the lab gate knows when it admits a private-range rule. Verified is set only
// after the lab asset passed the dev attest path; Networks are the verified lab networks (for
// example the compose bw-targets subnet). The zero value admits no private range.
type LabContext struct {
	Env      string
	Verified bool
	Networks []netip.Prefix
}

// ParseLabRules is ParseRules followed by CheckLab. The gateway snapshot loader uses it, so a
// private-range rule that is not admitted for this environment and lab never loads (fail closed).
func ParseLabRules(data []byte, lab LabContext) (*RuleSet, error) {
	rs, err := ParseRules(data)
	if err != nil {
		return nil, err
	}
	if err := rs.CheckLab(lab); err != nil {
		return nil, err
	}
	return rs, nil
}

// CheckLab enforces the private-range policy of #880 on every include rule that names an address
// overlapping a blocked range. Such a rule is admitted only when all of these hold:
//   - it does not overlap loopback, link-local or the metadata service (never admitted at all);
//   - BW_ENV is dev or test;
//   - the lab asset is verified through the dev attest path;
//   - the rule's prefix lies inside one of the verified lab networks, which are themselves
//     private (a public "lab" network is refused).
//
// Exclude rules and host-only rules are not private-range rules and are not checked here. A nil
// set passes.
func (rs *RuleSet) CheckLab(lab LabContext) error {
	if rs == nil {
		return nil
	}
	for _, n := range lab.Networks {
		if !netguard.BlockedContains(n) || netguard.NeverInScope(n) {
			return labErr("lab network %s is not a private range", n)
		}
	}
	for _, r := range rs.rules {
		if r.exclude || !r.prefix.IsValid() || !netguard.Blocked(r.prefix) {
			continue
		}
		if netguard.NeverInScope(r.prefix) {
			return labErr("%s: loopback, link-local and metadata ranges are never in scope", r.describe)
		}
		if lab.Env != EnvDev && lab.Env != EnvTest {
			return labErr("%s: private-range rules need BW_ENV dev or test", r.describe)
		}
		if !lab.Verified {
			return labErr("%s: private-range rules need a verified lab asset (dev attest)", r.describe)
		}
		if !insideAny(r.prefix, lab.Networks) {
			return labErr("%s: private range is outside the verified lab networks", r.describe)
		}
	}
	return nil
}

func insideAny(p netip.Prefix, nets []netip.Prefix) bool {
	for _, n := range nets {
		if n.Bits() <= p.Bits() && n.Contains(p.Addr()) {
			return true
		}
	}
	return false
}

// labErr wraps both sentinels: the shared SCOPE_INVALID_RULE code and the lab-specific one.
func labErr(format string, a ...any) error {
	return fmt.Errorf("%w: %w: %s", ErrInvalidRule, ErrLabRule, fmt.Sprintf(format, a...))
}
