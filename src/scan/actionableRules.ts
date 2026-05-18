export const ACTIONABLE_ATTRIBUTE_NAMES = [
	"data-e2e",
	"data-testid",
	"data-test",
	"data-cy",
	"aria-label",
	"title",
] as const;

export const ACTIONABLE_KEYWORD_PATTERN = String.raw`comment|reply|send|submit|input|search|like|digg|heart|star|favou?rite|collect|share|follow|card|item|video|play|button|btn|click|feed-comment|search-result|player|评论|回复|发送|发布|输入|搜索|点赞|喜欢|收藏|分享|关注`;

export const ACTIONABLE_HIGH_INTENT_PATTERN = String.raw`comment|reply|send|submit|input|search-result|feed-comment|评论|回复|发送|发布|输入`;

export const ACTIONABLE_PRIMARY_INTENT_PATTERN = String.raw`comment|reply|send|submit|feed-comment|评论|回复|发送|发布`;

export const FRAMEWORK_HANDLER_OWNER_PATTERN = String.raw`^__(reactProps|reactEventHandlers|vue|svelte|preact)`;

export const FRAMEWORK_ACTION_HANDLER_PATTERN = String.raw`Click|Pointer|Mouse|Key`;
