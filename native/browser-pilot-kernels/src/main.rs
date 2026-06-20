use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, Read};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use swc_common::{FileName, SourceMap, Span, Spanned, sync::Lrc};
use swc_ecma_ast::{
	ArrayLit, BinExpr, BinaryOp, BlockStmtOrExpr, Callee, Decl, Expr, ExprStmt, FnDecl, Function,
	Ident, Lit, MemberExpr, MemberProp, MethodProp, Module, ModuleDecl, ModuleItem, ObjectLit,
	Pat, Prop, PropName, PropOrSpread, Stmt, UnaryExpr, UnaryOp, VarDecl, VarDeclKind,
	VarDeclarator,
};
use swc_ecma_parser::{EsSyntax, Parser, StringInput, Syntax, lexer::Lexer};

const MAX_TREE_DIFF_INSTANCES: usize = 20;
const MAX_TREE_DIFF_CHANGED_FIELDS: usize = 8;
const MAX_TREE_DIFF_SUMMARY_NAMES: usize = 6;
const MAX_TEMPLATES: usize = 12;
const MIN_TEMPLATE_INSTANCES: usize = 4;
const MAX_REDUCTION_DEPTH: usize = 12;

fn main() {
	if let Err(error) = run() {
		eprintln!("{error}");
		std::process::exit(1);
	}
}

fn run() -> Result<(), String> {
	let command = std::env::args().nth(1).ok_or_else(|| "missing command".to_string())?;
	let mut input = String::new();
	io::stdin().read_to_string(&mut input).map_err(|error| error.to_string())?;
	match command.as_str() {
		"abml.diff" => emit(diff_entities(&parse_json::<AbmlDiffInput>(&input)?)),
		"abml.treeDiff" => emit(build_tree_diff(&parse_json::<AbmlTreeDiffInput>(&input)?)),
		"jsAst.reduce" => emit(apply_js_ast_reduction(&parse_json::<JsAstReductionInput>(&input)?)),
		other => Err(format!("unsupported command: {other}")),
	}
}

fn parse_json<T: for<'de> Deserialize<'de>>(input: &str) -> Result<T, String> {
	serde_json::from_str(input).map_err(|error| error.to_string())
}

fn emit<T: Serialize>(data: T) -> Result<(), String> {
	let envelope = serde_json::json!({ "ok": true, "data": data });
	println!("{}", serde_json::to_string(&envelope).map_err(|error| error.to_string())?);
	Ok(())
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityState {
	visible: bool,
	occluded: bool,
	disabled: bool,
	focused: bool,
	checked: Option<bool>,
	selected: Option<bool>,
	pressed: Option<bool>,
	expanded: Option<bool>,
	current: Option<Value>,
	editable: bool,
	in_viewport: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityStructure {
	set_size: Option<i64>,
	pos_in_set: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityHints {
	container_role: Option<String>,
	container_name: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entity {
	#[serde(rename = "ref")]
	ref_id: String,
	kind: String,
	role: String,
	name: Option<String>,
	value: Option<String>,
	#[serde(default)]
	state: EntityState,
	structure: Option<EntityStructure>,
	hints: Option<EntityHints>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityDiffOptions {
	partial_baseline: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffOptions {
	partial_baseline: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
struct AbmlDiffInput {
	before: Vec<Entity>,
	after: Vec<Entity>,
	#[serde(default)]
	options: EntityDiffOptions,
}

#[derive(Clone, Debug, Deserialize)]
struct AbmlTreeDiffInput {
	before: Vec<Entity>,
	after: Vec<Entity>,
	#[serde(default)]
	options: TreeDiffOptions,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum EntityChangeKind {
	StateChanged,
	NameChanged,
	ValueChanged,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntityChange {
	#[serde(rename = "ref")]
	ref_id: String,
	kind: EntityChangeKind,
	#[serde(skip_serializing_if = "Option::is_none")]
	before: Option<Value>,
	#[serde(skip_serializing_if = "Option::is_none")]
	after: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntityDiff {
	appeared: Vec<String>,
	disappeared: Vec<String>,
	changed: Vec<EntityChange>,
	#[serde(skip_serializing_if = "Option::is_none")]
	focused_ref: Option<String>,
}

fn state_keys() -> [&'static str; 11] {
	[
		"visible",
		"occluded",
		"disabled",
		"focused",
		"checked",
		"selected",
		"pressed",
		"expanded",
		"current",
		"editable",
		"inViewport",
	]
}

fn state_value(state: &EntityState, key: &str) -> Option<Value> {
	match key {
		"visible" => Some(Value::Bool(state.visible)),
		"occluded" => Some(Value::Bool(state.occluded)),
		"disabled" => Some(Value::Bool(state.disabled)),
		"focused" => Some(Value::Bool(state.focused)),
		"checked" => state.checked.map(Value::Bool),
		"selected" => state.selected.map(Value::Bool),
		"pressed" => state.pressed.map(Value::Bool),
		"expanded" => state.expanded.map(Value::Bool),
		"current" => state.current.clone(),
		"editable" => Some(Value::Bool(state.editable)),
		"inViewport" => Some(Value::Bool(state.in_viewport)),
		_ => None,
	}
}

fn state_delta(before: &EntityState, after: &EntityState) -> Option<(Value, Value)> {
	let mut before_delta = Map::new();
	let mut after_delta = Map::new();
	for key in state_keys() {
		let before_value = state_value(before, key);
		let after_value = state_value(after, key);
		if before_value == after_value {
			continue;
		}
		if let Some(value) = before_value {
			before_delta.insert(key.to_string(), value);
		}
		if let Some(value) = after_value {
			after_delta.insert(key.to_string(), value);
		}
	}
	if before_delta.is_empty() {
		None
	} else {
		Some((Value::Object(before_delta), Value::Object(after_delta)))
	}
}

fn diff_entities(input: &AbmlDiffInput) -> EntityDiff {
	let before_by_ref: HashMap<&str, &Entity> = input.before.iter().map(|entity| (entity.ref_id.as_str(), entity)).collect();
	let after_by_ref: HashMap<&str, &Entity> = input.after.iter().map(|entity| (entity.ref_id.as_str(), entity)).collect();
	let mut appeared = Vec::new();
	let mut disappeared = Vec::new();
	let mut changed = Vec::new();
	for entity in &input.after {
		let Some(previous) = before_by_ref.get(entity.ref_id.as_str()) else {
			if input.options.partial_baseline != Some(true) {
				appeared.push(entity.ref_id.clone());
			}
			continue;
		};
		if let Some((before_delta, after_delta)) = state_delta(&previous.state, &entity.state) {
			changed.push(EntityChange {
				ref_id: entity.ref_id.clone(),
				kind: EntityChangeKind::StateChanged,
				before: Some(before_delta),
				after: Some(after_delta),
			});
		}
		if previous.name != entity.name {
			changed.push(EntityChange {
				ref_id: entity.ref_id.clone(),
				kind: EntityChangeKind::NameChanged,
				before: Some(option_object("name", previous.name.clone())),
				after: Some(option_object("name", entity.name.clone())),
			});
		}
		if previous.value != entity.value {
			changed.push(EntityChange {
				ref_id: entity.ref_id.clone(),
				kind: EntityChangeKind::ValueChanged,
				before: Some(option_object("value", previous.value.clone())),
				after: Some(option_object("value", entity.value.clone())),
			});
		}
	}
	for entity in &input.before {
		if !after_by_ref.contains_key(entity.ref_id.as_str()) {
			disappeared.push(entity.ref_id.clone());
		}
	}
	let focused_ref = input.after.iter().find(|entity| entity.state.focused).map(|entity| entity.ref_id.clone());
	EntityDiff { appeared, disappeared, changed, focused_ref }
}

fn option_object(key: &str, value: Option<String>) -> Value {
	let mut out = Map::new();
	if let Some(text) = value {
		out.insert(key.to_string(), Value::String(text));
	}
	Value::Object(out)
}

#[derive(Clone)]
struct IndexedEntity {
	entity: Entity,
	index: usize,
}

#[derive(Clone)]
struct TemplateGroupDescriptor {
	key: String,
	container: Option<String>,
	container_name: Option<String>,
	role: String,
	kind: String,
	set_size: Option<i64>,
}

#[derive(Clone)]
struct TemplateGroup {
	descriptor: TemplateGroupDescriptor,
	members: Vec<IndexedEntity>,
}

fn normalize_entity_text(value: &Option<String>) -> Option<String> {
	let text = value.as_ref()?.split_whitespace().collect::<Vec<_>>().join(" ");
	if text.is_empty() { None } else { Some(text.to_lowercase()) }
}

fn display_entity_text(value: &Option<String>) -> Option<String> {
	let text = value.as_ref()?.split_whitespace().collect::<Vec<_>>().join(" ");
	if text.is_empty() {
		None
	} else {
		Some(text.chars().take(120).collect())
	}
}

fn group_signal(entity: &Entity) -> Option<Value> {
	let container_role = entity.hints.as_ref().and_then(|hints| hints.container_role.clone()).filter(|text| !text.trim().is_empty());
	if let Some(container) = container_role {
		return Some(Value::Array(vec![
			Value::String("c".to_string()),
			Value::String(container),
			Value::String(entity.hints.as_ref().and_then(|hints| hints.container_name.clone()).unwrap_or_default()),
		]));
	}
	let set_size = entity.structure.as_ref().and_then(|structure| structure.set_size);
	if let Some(size) = set_size {
		if size >= MIN_TEMPLATE_INSTANCES as i64 {
			return Some(Value::Array(vec![Value::String("s".to_string()), Value::Number(size.into())]));
		}
	}
	None
}

fn template_group_descriptor_for_entity(entity: &Entity) -> Option<TemplateGroupDescriptor> {
	let signal = group_signal(entity)?;
	let key = serde_json::to_string(&Value::Array(vec![signal.clone(), Value::String(entity.role.clone()), Value::String(entity.kind.clone())])).ok()?;
	if let Value::Array(parts) = signal {
		if parts.first().and_then(Value::as_str) == Some("c") {
			let container = parts.get(1).and_then(Value::as_str).map(str::to_string);
			let container_name = parts.get(2).and_then(Value::as_str).map(str::to_string).filter(|text| !text.is_empty());
			return Some(TemplateGroupDescriptor {
				key,
				container,
				container_name,
				role: entity.role.clone(),
				kind: entity.kind.clone(),
				set_size: entity.structure.as_ref().and_then(|structure| structure.set_size),
			});
		}
	}
	Some(TemplateGroupDescriptor {
		key,
		container: None,
		container_name: None,
		role: entity.role.clone(),
		kind: entity.kind.clone(),
		set_size: entity.structure.as_ref().and_then(|structure| structure.set_size),
	})
}

fn structure_scope_key(descriptor: &TemplateGroupDescriptor) -> String {
	if let Some(container) = &descriptor.container {
		serde_json::to_string(&Value::Array(vec![
			Value::String("c".to_string()),
			Value::String(container.clone()),
			Value::String(descriptor.container_name.clone().unwrap_or_default()),
		])).unwrap_or_default()
	} else {
		serde_json::to_string(&Value::Array(vec![
			Value::String("s".to_string()),
			descriptor.set_size.map(|value| Value::Number(value.into())).unwrap_or_else(|| Value::String(String::new())),
		])).unwrap_or_default()
	}
}

fn build_groups(entities: &[Entity]) -> Vec<TemplateGroup> {
	let mut groups: HashMap<String, TemplateGroup> = HashMap::new();
	for (index, entity) in entities.iter().enumerate() {
		let Some(descriptor) = template_group_descriptor_for_entity(entity) else { continue; };
		groups.entry(descriptor.key.clone()).and_modify(|group| {
			group.members.push(IndexedEntity { entity: entity.clone(), index });
		}).or_insert_with(|| TemplateGroup { descriptor, members: vec![IndexedEntity { entity: entity.clone(), index }] });
	}
	groups.into_values().filter(|group| group.members.len() >= MIN_TEMPLATE_INSTANCES).collect()
}

fn suppress_nested_non_control_groups(groups: Vec<TemplateGroup>) -> Vec<TemplateGroup> {
	let scopes_with_controls: HashSet<String> = groups.iter().filter(|group| group.descriptor.kind == "control").map(|group| structure_scope_key(&group.descriptor)).collect();
	if scopes_with_controls.is_empty() {
		return groups;
	}
	groups.into_iter().filter(|group| group.descriptor.kind == "control" || !scopes_with_controls.contains(&structure_scope_key(&group.descriptor))).collect()
}

fn group_entities(entities: &[Entity]) -> Vec<TemplateGroup> {
	suppress_nested_non_control_groups(build_groups(entities))
}

fn build_name_counts(before_groups: &[TemplateGroup], after_groups: &[TemplateGroup]) -> HashMap<String, (usize, usize)> {
	let mut counts = HashMap::new();
	for (side, groups) in [(0usize, before_groups), (1usize, after_groups)] {
		for group in groups {
			for item in &group.members {
				let Some(name) = normalize_entity_text(&item.entity.name) else { continue; };
				let key = format!("{}\0{}", group.descriptor.key, name);
				let entry = counts.entry(key).or_insert((0usize, 0usize));
				if side == 0 {
					entry.0 += 1;
				} else {
					entry.1 += 1;
				}
			}
		}
	}
	counts
}

#[derive(Clone)]
struct MatchedInstance {
	key: String,
	ref_id: String,
	anchor: String,
	confidence: String,
	name: Option<String>,
	value: Option<String>,
	pos_in_set: Option<i64>,
	entity: Entity,
}

fn instance_key(group_key: &str, item: &IndexedEntity, counts: &HashMap<String, (usize, usize)>) -> (String, String, String) {
	if let Some(name) = normalize_entity_text(&item.entity.name) {
		let key = format!("{}\0{}", group_key, name);
		if let Some((before, after)) = counts.get(&key) {
			if *before <= 1 && *after <= 1 {
				return (format!("name:{name}"), "name".to_string(), "high".to_string());
			}
		}
	}
	if let Some(pos_in_set) = item.entity.structure.as_ref().and_then(|structure| structure.pos_in_set) {
		return (format!("pos:{pos_in_set}"), "posInSet".to_string(), "low".to_string());
	}
	(format!("idx:{}", item.index + 1), "index".to_string(), "low".to_string())
}

fn matched_instances(group: &TemplateGroup, counts: &HashMap<String, (usize, usize)>) -> Vec<MatchedInstance> {
	group.members.iter().map(|item| {
		let (key, anchor, confidence) = instance_key(&group.descriptor.key, item, counts);
		MatchedInstance {
			key,
			ref_id: item.entity.ref_id.clone(),
			anchor,
			confidence,
			name: display_entity_text(&item.entity.name),
			value: display_entity_text(&item.entity.value),
			pos_in_set: item.entity.structure.as_ref().and_then(|structure| structure.pos_in_set),
			entity: item.entity.clone(),
		}
	}).collect()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffFieldChange {
	field: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	before: Option<Value>,
	#[serde(skip_serializing_if = "Option::is_none")]
	after: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffInstance {
	key: String,
	#[serde(rename = "ref")]
	ref_id: String,
	anchor: String,
	confidence: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	name: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	value: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pos_in_set: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffInstanceChange {
	key: String,
	before_ref: String,
	after_ref: String,
	anchor: String,
	confidence: String,
	fields: Vec<TreeDiffFieldChange>,
	field_count: usize,
	#[serde(skip_serializing_if = "Option::is_none")]
	fields_truncated: Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffInstanceBucket {
	count: usize,
	instances: Vec<TreeDiffInstance>,
	#[serde(skip_serializing_if = "Option::is_none")]
	truncated: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffChangedBucket {
	count: usize,
	instances: Vec<TreeDiffInstanceChange>,
	#[serde(skip_serializing_if = "Option::is_none")]
	truncated: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffReordered {
	changed: bool,
	common_count: usize,
	before_sample: Vec<String>,
	after_sample: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeTemplateDiff {
	template_key: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	container: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	container_name: Option<String>,
	role: String,
	kind: String,
	before_count: usize,
	after_count: usize,
	appeared: TreeDiffInstanceBucket,
	disappeared: TreeDiffInstanceBucket,
	changed: TreeDiffChangedBucket,
	#[serde(skip_serializing_if = "Option::is_none")]
	reordered: Option<TreeDiffReordered>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffSummary {
	template_count: usize,
	changed_template_count: usize,
	appeared: usize,
	disappeared: usize,
	changed: usize,
	reordered: usize,
	#[serde(skip_serializing_if = "Option::is_none")]
	sample: Option<TreeDiffSummarySample>,
	#[serde(skip_serializing_if = "Option::is_none")]
	partial_baseline: Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	unavailable: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeDiffSummarySample {
	#[serde(skip_serializing_if = "Option::is_none")]
	appeared: Option<Vec<String>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	disappeared: Option<Vec<String>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	changed: Option<Vec<String>>,
}

#[derive(Clone, Serialize)]
struct TreeDiff {
	summary: TreeDiffSummary,
	templates: Vec<TreeTemplateDiff>,
}

fn template_field_value(entity: &Entity, field: &str) -> Option<Value> {
	match field {
		"name" => entity.name.clone().map(Value::String),
		"value" => entity.value.clone().map(Value::String),
		"checked" => entity.state.checked.map(Value::Bool),
		"selected" => entity.state.selected.map(Value::Bool),
		"pressed" => entity.state.pressed.map(Value::Bool),
		"current" => entity.state.current.clone(),
		"disabled" => Some(Value::Bool(entity.state.disabled)),
		_ => None,
	}
}

fn instance_summary(instance: &MatchedInstance) -> TreeDiffInstance {
	TreeDiffInstance {
		key: instance.key.clone(),
		ref_id: instance.ref_id.clone(),
		anchor: instance.anchor.clone(),
		confidence: instance.confidence.clone(),
		name: instance.name.clone(),
		value: instance.value.clone(),
		pos_in_set: instance.pos_in_set,
	}
}

fn bucket(items: &[MatchedInstance]) -> TreeDiffInstanceBucket {
	TreeDiffInstanceBucket {
		count: items.len(),
		instances: items.iter().take(MAX_TREE_DIFF_INSTANCES).map(instance_summary).collect(),
		truncated: (items.len() > MAX_TREE_DIFF_INSTANCES).then_some(true),
	}
}

fn changed_bucket(items: &[TreeDiffInstanceChange]) -> TreeDiffChangedBucket {
	TreeDiffChangedBucket {
		count: items.len(),
		instances: items.iter().take(MAX_TREE_DIFF_INSTANCES).cloned().collect(),
		truncated: (items.len() > MAX_TREE_DIFF_INSTANCES).then_some(true),
	}
}

fn field_changes(before: &Entity, after: &Entity) -> (Vec<TreeDiffFieldChange>, usize) {
	let mut out = Vec::new();
	for field in ["name", "value", "checked", "selected", "pressed", "current", "disabled"] {
		let before_value = template_field_value(before, field);
		let after_value = template_field_value(after, field);
		if before_value == after_value {
			continue;
		}
		out.push(TreeDiffFieldChange { field: field.to_string(), before: before_value, after: after_value });
	}
	let field_count = out.len();
	(out.into_iter().take(MAX_TREE_DIFF_CHANGED_FIELDS).collect(), field_count)
}

fn reordered(before: &[MatchedInstance], after: &[MatchedInstance]) -> Option<TreeDiffReordered> {
	let before_keys: Vec<String> = before.iter().map(|item| item.key.clone()).collect();
	let after_key_set: HashSet<&str> = after.iter().map(|item| item.key.as_str()).collect();
	let before_common: Vec<String> = before_keys.iter().filter(|key| after_key_set.contains(key.as_str())).cloned().collect();
	let before_key_set: HashSet<&str> = before_keys.iter().map(String::as_str).collect();
	let after_common: Vec<String> = after.iter().map(|item| item.key.clone()).filter(|key| before_key_set.contains(key.as_str())).collect();
	if before_common.len() < 2 || before_common == after_common {
		return None;
	}
	Some(TreeDiffReordered {
		changed: true,
		common_count: before_common.len(),
		before_sample: before_common.into_iter().take(12).collect(),
		after_sample: after_common.into_iter().take(12).collect(),
	})
}

fn build_template_diff(before_group: Option<&TemplateGroup>, after_group: Option<&TemplateGroup>, counts: &HashMap<String, (usize, usize)>) -> Option<TreeTemplateDiff> {
	let descriptor = after_group.map(|group| group.descriptor.clone()).or_else(|| before_group.map(|group| group.descriptor.clone()))?;
	let before = before_group.map(|group| matched_instances(group, counts)).unwrap_or_default();
	let after = after_group.map(|group| matched_instances(group, counts)).unwrap_or_default();
	let before_by_key: HashMap<&str, &MatchedInstance> = before.iter().map(|item| (item.key.as_str(), item)).collect();
	let after_by_key: HashMap<&str, &MatchedInstance> = after.iter().map(|item| (item.key.as_str(), item)).collect();
	let appeared: Vec<MatchedInstance> = after.iter().filter(|item| !before_by_key.contains_key(item.key.as_str())).cloned().collect();
	let disappeared: Vec<MatchedInstance> = before.iter().filter(|item| !after_by_key.contains_key(item.key.as_str())).cloned().collect();
	let mut changed = Vec::new();
	for item in &after {
		let Some(prior) = before_by_key.get(item.key.as_str()) else { continue; };
		let (fields, field_count) = field_changes(&prior.entity, &item.entity);
		if fields.is_empty() {
			continue;
		}
		changed.push(TreeDiffInstanceChange {
			key: item.key.clone(),
			before_ref: prior.ref_id.clone(),
			after_ref: item.ref_id.clone(),
			anchor: item.anchor.clone(),
			confidence: item.confidence.clone(),
			fields,
			field_count,
			fields_truncated: (field_count > MAX_TREE_DIFF_CHANGED_FIELDS).then_some(true),
			name: item.name.clone(),
		});
	}
	let order = reordered(&before, &after);
	if appeared.is_empty() && disappeared.is_empty() && changed.is_empty() && order.is_none() {
		return None;
	}
	Some(TreeTemplateDiff {
		template_key: descriptor.key,
		container: descriptor.container,
		container_name: descriptor.container_name,
		role: descriptor.role,
		kind: descriptor.kind,
		before_count: before.len(),
		after_count: after.len(),
		appeared: bucket(&appeared),
		disappeared: bucket(&disappeared),
		changed: changed_bucket(&changed),
		reordered: order,
	})
}

fn template_diff_signal_score(diff: &TreeTemplateDiff) -> i64 {
	(diff.changed.count as i64) * 40 + (diff.appeared.count as i64) * 12 + (diff.disappeared.count as i64) * 12 + if diff.reordered.is_some() { 4 } else { 0 }
}

fn build_tree_diff(input: &AbmlTreeDiffInput) -> TreeDiff {
	if input.options.partial_baseline == Some(true) {
		return TreeDiff {
			summary: TreeDiffSummary {
				template_count: 0,
				changed_template_count: 0,
				appeared: 0,
				disappeared: 0,
				changed: 0,
				reordered: 0,
				sample: None,
				partial_baseline: Some(true),
				unavailable: Some("treeDiff requires a full baseline; partial baselines suppress structure-level change projection".to_string()),
			},
			templates: Vec::new(),
		};
	}
	let before_groups = group_entities(&input.before);
	let after_groups = group_entities(&input.after);
	let counts = build_name_counts(&before_groups, &after_groups);
	let mut all_keys = HashSet::new();
	let before_by_key: HashMap<String, TemplateGroup> = before_groups.into_iter().map(|group| {
		all_keys.insert(group.descriptor.key.clone());
		(group.descriptor.key.clone(), group)
	}).collect();
	let after_by_key: HashMap<String, TemplateGroup> = after_groups.into_iter().map(|group| {
		all_keys.insert(group.descriptor.key.clone());
		(group.descriptor.key.clone(), group)
	}).collect();
	let mut templates: Vec<TreeTemplateDiff> = all_keys.into_iter().filter_map(|key| build_template_diff(before_by_key.get(&key), after_by_key.get(&key), &counts)).collect();
	templates.sort_by(|a, b| {
		template_diff_signal_score(b).cmp(&template_diff_signal_score(a)).then_with(|| std::cmp::max(b.before_count, b.after_count).cmp(&std::cmp::max(a.before_count, a.after_count)))
	});
	templates.truncate(MAX_TEMPLATES);
	let mut summary = TreeDiffSummary {
		template_count: before_by_key.len() + after_by_key.keys().filter(|key| !before_by_key.contains_key(*key)).count(),
		changed_template_count: 0,
		appeared: 0,
		disappeared: 0,
		changed: 0,
		reordered: 0,
		sample: None,
		partial_baseline: None,
		unavailable: None,
	};
	for item in &templates {
		summary.changed_template_count += 1;
		summary.appeared += item.appeared.count;
		summary.disappeared += item.disappeared.count;
		summary.changed += item.changed.count;
		summary.reordered += usize::from(item.reordered.is_some());
	}
	let appeared_names = collect_tree_diff_names(&templates, |template| template.appeared.instances.iter().filter_map(|item| item.name.clone()).collect());
	let disappeared_names = collect_tree_diff_names(&templates, |template| template.disappeared.instances.iter().filter_map(|item| item.name.clone()).collect());
	let changed_names = collect_tree_diff_names(&templates, |template| template.changed.instances.iter().filter_map(|item| item.name.clone()).collect());
	if !appeared_names.is_empty() || !disappeared_names.is_empty() || !changed_names.is_empty() {
		summary.sample = Some(TreeDiffSummarySample {
			appeared: (!appeared_names.is_empty()).then_some(appeared_names),
			disappeared: (!disappeared_names.is_empty()).then_some(disappeared_names),
			changed: (!changed_names.is_empty()).then_some(changed_names),
		});
	}
	TreeDiff { summary, templates }
}

fn collect_tree_diff_names<F>(templates: &[TreeTemplateDiff], pick: F) -> Vec<String>
where
	F: Fn(&TreeTemplateDiff) -> Vec<String>,
{
	let mut out = Vec::new();
	for template in templates {
		for name in pick(template) {
			if !out.contains(&name) {
				out.push(name);
				if out.len() >= MAX_TREE_DIFF_SUMMARY_NAMES {
					return out;
				}
			}
		}
	}
	out
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsAstReductionInput {
	source_text: String,
	candidate_names: Vec<String>,
	object_dispatch_names: Vec<String>,
	options: JsAstReductionOptions,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsAstReductionOptions {
	max_reduction_examples: usize,
	max_reduction_preview_chars: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JsAstReductionFact {
	applied: bool,
	replacement_count: usize,
	passes: Vec<String>,
	pass_counts: BTreeMap<String, usize>,
	preview: String,
	truncated: bool,
	examples: Vec<JsAstReductionExample>,
}

#[derive(Clone, Debug, Serialize)]
struct JsAstReductionExample {
	from: String,
	to: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pass: Option<String>,
}

#[derive(Clone)]
struct Replacement {
	start: usize,
	end: usize,
	text: String,
	from: String,
	to: String,
	pass: String,
}

#[derive(Clone)]
struct ReductionContext {
	source_text: String,
	candidate_names: HashSet<String>,
	candidate_values: HashMap<String, Vec<String>>,
	aliases: HashMap<String, String>,
	const_bindings: HashMap<String, Expr>,
	known_decoders: HashMap<String, String>,
	object_dispatch_names: HashSet<String>,
	object_dispatch_map: HashMap<String, HashMap<String, Expr>>,
}

fn apply_js_ast_reduction(input: &JsAstReductionInput) -> JsAstReductionFact {
	let Some(module) = parse_module(&input.source_text) else {
		return JsAstReductionFact { applied: false, replacement_count: 0, passes: Vec::new(), pass_counts: BTreeMap::new(), preview: String::new(), truncated: false, examples: Vec::new() };
	};
	let mut context = ReductionContext {
		source_text: input.source_text.clone(),
		candidate_names: input.candidate_names.iter().cloned().collect(),
		candidate_values: HashMap::new(),
		aliases: HashMap::new(),
		const_bindings: HashMap::new(),
		known_decoders: HashMap::new(),
		object_dispatch_names: input.object_dispatch_names.iter().cloned().collect(),
		object_dispatch_map: HashMap::new(),
	};
	collect_reduction_context(&module, &mut context);
	stabilize_decoder_aliases(&mut context);
	collect_object_dispatch_map(&module, &mut context);
	let mut replacements = Vec::new();
	collect_replacements_from_module(&module, &context, &mut replacements);
	let selected = select_non_overlapping_replacements(replacements);
	if selected.is_empty() {
		return JsAstReductionFact { applied: false, replacement_count: 0, passes: Vec::new(), pass_counts: BTreeMap::new(), preview: String::new(), truncated: false, examples: Vec::new() };
	}
	let mut reduced = input.source_text.clone();
	for replacement in selected.iter().rev() {
		reduced.replace_range(replacement.start..replacement.end, &replacement.text);
	}
	let truncated = reduced.chars().count() > input.options.max_reduction_preview_chars;
	let preview = if truncated {
		reduced.chars().take(input.options.max_reduction_preview_chars).collect::<String>() + "…"
	} else {
		reduced.clone()
	};
	let mut pass_counts = BTreeMap::new();
	for replacement in &selected {
		*pass_counts.entry(replacement.pass.clone()).or_insert(0) += 1;
	}
	let mut passes = Vec::new();
	for pass in ["stringArrayElement", "decoderCall", "constantExpression"] {
		if pass_counts.contains_key(pass) {
			passes.push(pass.to_string());
		}
	}
	JsAstReductionFact {
		applied: true,
		replacement_count: selected.len(),
		passes,
		pass_counts,
		preview,
		truncated,
		examples: selected.into_iter().take(input.options.max_reduction_examples).map(|item| JsAstReductionExample { from: item.from, to: item.to, pass: Some(item.pass) }).collect(),
	}
}

fn parse_module(source_text: &str) -> Option<Module> {
	let cm: Lrc<SourceMap> = Default::default();
	let file = cm.new_source_file(FileName::Custom("inline.js".into()).into(), source_text.to_string());
	let lexer = Lexer::new(
		Syntax::Es(EsSyntax {
			jsx: false,
			..Default::default()
		}),
		Default::default(),
		StringInput::from(&*file),
		None,
	);
	let mut parser = Parser::new_from(lexer);
	parser.parse_module().ok()
}

fn collect_reduction_context(module: &Module, context: &mut ReductionContext) {
	for item in &module.body {
		collect_context_from_module_item(item, context);
	}
}

fn collect_context_from_module_item(item: &ModuleItem, context: &mut ReductionContext) {
	match item {
		ModuleItem::Stmt(statement) => collect_context_from_stmt(statement, context),
		ModuleItem::ModuleDecl(decl) => {
			if let ModuleDecl::ExportDecl(export) = decl {
				collect_decl(&export.decl, context);
			}
		}
	}
}

fn collect_context_from_stmt(statement: &Stmt, context: &mut ReductionContext) {
	match statement {
		Stmt::Decl(decl) => collect_decl(decl, context),
		Stmt::Block(block) => for statement in &block.stmts { collect_context_from_stmt(statement, context); },
		Stmt::If(stmt) => {
			collect_context_from_stmt(&stmt.cons, context);
			if let Some(alt) = &stmt.alt { collect_context_from_stmt(alt, context); }
		}
		Stmt::While(stmt) => collect_context_from_stmt(&stmt.body, context),
		Stmt::For(stmt) => {
			if let Some(init) = &stmt.init {
				match init {
					swc_ecma_ast::VarDeclOrExpr::VarDecl(var_decl) => collect_var_decl(var_decl, context),
					swc_ecma_ast::VarDeclOrExpr::Expr(_) => {}
				}
			}
			collect_context_from_stmt(&stmt.body, context);
		}
		_ => {}
	}
}

fn collect_decl(decl: &Decl, context: &mut ReductionContext) {
	match decl {
		Decl::Var(var_decl) => collect_var_decl(var_decl, context),
		Decl::Fn(fn_decl) => collect_fn_decl(fn_decl, context),
		_ => {}
	}
}

fn collect_var_decl(var_decl: &VarDecl, context: &mut ReductionContext) {
	for declarator in &var_decl.decls {
		collect_var_declarator(declarator, var_decl.kind, context);
	}
}

fn collect_var_declarator(declarator: &VarDeclarator, kind: VarDeclKind, context: &mut ReductionContext) {
	let Pat::Ident(binding) = &declarator.name else { return; };
	let name = binding.id.sym.to_string();
	let Some(init) = &declarator.init else { return; };
	if context.candidate_names.contains(&name) {
		if let Some(values) = array_string_values(init) {
			context.candidate_values.insert(name.clone(), values);
		}
	}
	if let Expr::Ident(target) = &**init {
		context.aliases.insert(name.clone(), target.sym.to_string());
	}
	if kind == VarDeclKind::Const {
		context.const_bindings.insert(name.clone(), (**init).clone());
	}
	if let Some(array_name) = function_returns_string_array_index_from_expr(init) {
		context.known_decoders.insert(name.clone(), array_name);
	}
}

fn collect_fn_decl(fn_decl: &FnDecl, context: &mut ReductionContext) {
	if let Some(array_name) = function_returns_string_array_index(&fn_decl.function) {
		context.known_decoders.insert(fn_decl.ident.sym.to_string(), array_name);
	}
}

fn stabilize_decoder_aliases(context: &mut ReductionContext) {
	loop {
		let mut changed = false;
		let aliases: Vec<(String, String)> = context.aliases.iter().map(|(key, value)| (key.clone(), value.clone())).collect();
		for (alias, target) in aliases {
			if context.known_decoders.contains_key(&alias) {
				continue;
			}
			if let Some(array_name) = context.known_decoders.get(&target).cloned() {
				context.known_decoders.insert(alias, array_name);
				changed = true;
			}
		}
		if !changed {
			break;
		}
	}
}

fn collect_object_dispatch_map(module: &Module, context: &mut ReductionContext) {
	for item in &module.body {
		match item {
			ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => {
				for declarator in &var_decl.decls {
					let Pat::Ident(binding) = &declarator.name else { continue; };
					let name = binding.id.sym.to_string();
					if !context.object_dispatch_names.contains(&name) {
						continue;
					}
					let Some(init) = &declarator.init else { continue; };
					let Expr::Object(object_lit) = &**init else { continue; };
					context.object_dispatch_map.insert(name, object_dispatch_entries(object_lit));
				}
			}
			ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export)) => {
				if let Decl::Var(var_decl) = &export.decl {
					for declarator in &var_decl.decls {
						let Pat::Ident(binding) = &declarator.name else { continue; };
						let name = binding.id.sym.to_string();
						if !context.object_dispatch_names.contains(&name) { continue; }
						let Some(init) = &declarator.init else { continue; };
						let Expr::Object(object_lit) = &**init else { continue; };
						context.object_dispatch_map.insert(name, object_dispatch_entries(object_lit));
					}
				}
			}
			_ => {}
		}
	}
}

fn array_string_values(expr: &Expr) -> Option<Vec<String>> {
	let Expr::Array(ArrayLit { elems, .. }) = expr else { return None; };
	let mut out = Vec::with_capacity(elems.len());
	for element in elems {
		let expr = element.as_ref()?.expr.as_ref();
		match expr {
			Expr::Lit(Lit::Str(text)) => out.push(text.value.to_string_lossy().to_string()),
			_ => return None,
		}
	}
	Some(out)
}

fn function_returns_string_array_index(function: &Function) -> Option<String> {
	let body = function.body.as_ref()?;
	if body.stmts.len() != 1 { return None; }
	let Stmt::Return(return_stmt) = &body.stmts[0] else { return None; };
	let expr = return_stmt.arg.as_ref()?;
	string_array_name_from_index_expr(expr)
}

fn function_returns_string_array_index_from_expr(expr: &Expr) -> Option<String> {
	match expr {
		Expr::Fn(function_expr) => function_returns_string_array_index(&function_expr.function),
		Expr::Arrow(arrow) => match &*arrow.body {
			BlockStmtOrExpr::Expr(expr) => string_array_name_from_index_expr(expr),
			BlockStmtOrExpr::BlockStmt(block) => {
				if block.stmts.len() != 1 { return None; }
				let Stmt::Return(return_stmt) = &block.stmts[0] else { return None; };
				string_array_name_from_index_expr(return_stmt.arg.as_ref()?)
			}
		},
		_ => None,
	}
}

fn string_array_name_from_index_expr(expr: &Expr) -> Option<String> {
	let Expr::Member(member) = expr else { return None; };
	let MemberProp::Computed(_) = &member.prop else { return None; };
	let Expr::Ident(object) = &*member.obj else { return None; };
	Some(object.sym.to_string())
}

fn object_dispatch_entries(object_lit: &ObjectLit) -> HashMap<String, Expr> {
	let mut entries = HashMap::new();
	for property in &object_lit.props {
		let PropOrSpread::Prop(prop) = property else { continue; };
		match &**prop {
			Prop::KeyValue(property) => {
				let Some(key) = prop_name_text(&property.key) else { continue; };
				let Some(expr) = return_expression_from_expr(&property.value) else { continue; };
				entries.insert(key, expr.clone());
			}
			Prop::Method(MethodProp { key, function }) => {
				let Some(name) = prop_name_text(key) else { continue; };
				let Some(expr) = function_returns_expression(function) else { continue; };
				entries.insert(name, expr.clone());
			}
			_ => {}
		}
	}
	entries
}

fn function_returns_expression(function: &Function) -> Option<&Expr> {
	let body = function.body.as_ref()?;
	if body.stmts.len() != 1 { return None; }
	let Stmt::Return(return_stmt) = &body.stmts[0] else { return None; };
	return_stmt.arg.as_deref()
}

fn return_expression_from_expr(expr: &Expr) -> Option<&Expr> {
	match expr {
		Expr::Fn(function_expr) => function_returns_expression(&function_expr.function),
		Expr::Arrow(arrow) => match &*arrow.body {
			BlockStmtOrExpr::Expr(expr) => Some(expr),
			BlockStmtOrExpr::BlockStmt(block) => {
				if block.stmts.len() != 1 { return None; }
				let Stmt::Return(return_stmt) = &block.stmts[0] else { return None; };
				return_stmt.arg.as_deref()
			}
		},
		_ => None,
	}
}

fn prop_name_text(name: &PropName) -> Option<String> {
	match name {
		PropName::Ident(ident) => Some(ident.sym.to_string()),
		PropName::Str(text) => Some(text.value.to_string_lossy().to_string()),
		PropName::Num(number) => Some(number.value.to_string()),
		_ => None,
	}
}

fn collect_replacements_from_module(module: &Module, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	for item in &module.body {
		collect_replacements_from_module_item(item, context, replacements);
	}
}

fn collect_replacements_from_module_item(item: &ModuleItem, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	match item {
		ModuleItem::Stmt(statement) => collect_replacements_from_stmt(statement, context, replacements),
		ModuleItem::ModuleDecl(decl) => match decl {
			ModuleDecl::ExportDecl(export) => collect_replacements_from_decl(&export.decl, context, replacements),
			ModuleDecl::ExportDefaultExpr(export) => collect_replacements_from_expr(&export.expr, context, replacements),
			_ => {}
		},
	}
}

fn collect_replacements_from_decl(decl: &Decl, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	match decl {
		Decl::Var(var_decl) => for declarator in &var_decl.decls { collect_replacements_from_var_declarator(declarator, context, replacements); },
		Decl::Fn(fn_decl) => collect_replacements_from_function(&fn_decl.function, context, replacements),
		_ => {}
	}
}

fn collect_replacements_from_var_declarator(declarator: &VarDeclarator, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	collect_replacements_from_pat(&declarator.name, context, replacements);
	if let Some(init) = &declarator.init {
		collect_replacements_from_expr(init, context, replacements);
	}
}

fn collect_replacements_from_pat(pat: &Pat, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	match pat {
		Pat::Ident(binding) => collect_replacements_from_ident(&binding.id, context, replacements),
		Pat::Array(array_pat) => for item in &array_pat.elems { if let Some(item) = item { collect_replacements_from_pat(item, context, replacements); } },
		Pat::Object(object_pat) => for property in &object_pat.props {
			match property {
				swc_ecma_ast::ObjectPatProp::Assign(assign) => collect_replacements_from_ident(&assign.key, context, replacements),
				swc_ecma_ast::ObjectPatProp::KeyValue(key_value) => collect_replacements_from_pat(&key_value.value, context, replacements),
				swc_ecma_ast::ObjectPatProp::Rest(rest) => collect_replacements_from_pat(&rest.arg, context, replacements),
			}
		},
		Pat::Assign(assign) => {
			collect_replacements_from_pat(&assign.left, context, replacements);
			collect_replacements_from_expr(&assign.right, context, replacements);
		}
		Pat::Expr(expr) => collect_replacements_from_expr(expr, context, replacements),
		Pat::Rest(rest) => collect_replacements_from_pat(&rest.arg, context, replacements),
		_ => {}
	}
}

fn collect_replacements_from_ident(ident: &Ident, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	let expr = Expr::Ident(ident.clone());
	record_replacement(&expr, ident.span, context, replacements);
}

fn collect_replacements_from_function(function: &Function, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	for parameter in &function.params {
		collect_replacements_from_pat(&parameter.pat, context, replacements);
	}
	if let Some(body) = &function.body {
		for statement in &body.stmts {
			collect_replacements_from_stmt(statement, context, replacements);
		}
	}
}

fn collect_replacements_from_stmt(statement: &Stmt, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	match statement {
		Stmt::Expr(ExprStmt { expr, .. }) => collect_replacements_from_expr(expr, context, replacements),
		Stmt::Decl(decl) => collect_replacements_from_decl(decl, context, replacements),
		Stmt::Block(block) => for statement in &block.stmts { collect_replacements_from_stmt(statement, context, replacements); },
		Stmt::If(stmt) => {
			collect_replacements_from_expr(&stmt.test, context, replacements);
			collect_replacements_from_stmt(&stmt.cons, context, replacements);
			if let Some(alt) = &stmt.alt { collect_replacements_from_stmt(alt, context, replacements); }
		}
		Stmt::While(stmt) => {
			collect_replacements_from_expr(&stmt.test, context, replacements);
			collect_replacements_from_stmt(&stmt.body, context, replacements);
		}
		Stmt::For(stmt) => {
			if let Some(init) = &stmt.init {
				match init {
					swc_ecma_ast::VarDeclOrExpr::VarDecl(var_decl) => collect_replacements_from_decl(&Decl::Var(var_decl.clone()), context, replacements),
					swc_ecma_ast::VarDeclOrExpr::Expr(expr) => collect_replacements_from_expr(expr, context, replacements),
				}
			}
			if let Some(test) = &stmt.test { collect_replacements_from_expr(test, context, replacements); }
			if let Some(update) = &stmt.update { collect_replacements_from_expr(update, context, replacements); }
			collect_replacements_from_stmt(&stmt.body, context, replacements);
		}
		Stmt::Return(stmt) => if let Some(arg) = &stmt.arg { collect_replacements_from_expr(arg, context, replacements); },
		Stmt::Switch(stmt) => {
			collect_replacements_from_expr(&stmt.discriminant, context, replacements);
			for case in &stmt.cases {
				if let Some(test) = &case.test { collect_replacements_from_expr(test, context, replacements); }
				for statement in &case.cons { collect_replacements_from_stmt(statement, context, replacements); }
			}
		}
		_ => {}
	}
}

fn collect_replacements_from_expr(expr: &Expr, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	record_replacement(expr, expr.span(), context, replacements);
	match expr {
		Expr::Array(array_lit) => for element in &array_lit.elems { if let Some(element) = element { collect_replacements_from_expr(&element.expr, context, replacements); } },
		Expr::Assign(assign) => {
			collect_replacements_from_pat_or_expr(&assign.left, context, replacements);
			collect_replacements_from_expr(&assign.right, context, replacements);
		}
		Expr::Await(await_expr) => collect_replacements_from_expr(&await_expr.arg, context, replacements),
		Expr::Bin(bin_expr) => {
			collect_replacements_from_expr(&bin_expr.left, context, replacements);
			collect_replacements_from_expr(&bin_expr.right, context, replacements);
		}
		Expr::Call(call_expr) => {
			match &call_expr.callee {
				Callee::Expr(callee) => collect_replacements_from_expr(callee, context, replacements),
				_ => {}
			}
			for argument in &call_expr.args { collect_replacements_from_expr(&argument.expr, context, replacements); }
		}
		Expr::Cond(cond_expr) => {
			collect_replacements_from_expr(&cond_expr.test, context, replacements);
			collect_replacements_from_expr(&cond_expr.cons, context, replacements);
			collect_replacements_from_expr(&cond_expr.alt, context, replacements);
		}
		Expr::Member(member) => {
			collect_replacements_from_expr(&member.obj, context, replacements);
			if let MemberProp::Computed(computed) = &member.prop { collect_replacements_from_expr(&computed.expr, context, replacements); }
		}
		Expr::Object(object_lit) => for property in &object_lit.props {
			let PropOrSpread::Prop(prop) = property else { continue; };
			match &**prop {
				Prop::KeyValue(property) => collect_replacements_from_expr(&property.value, context, replacements),
				Prop::Method(method) => collect_replacements_from_function(&method.function, context, replacements),
				Prop::Getter(getter) => if let Some(body) = &getter.body { for statement in &body.stmts { collect_replacements_from_stmt(statement, context, replacements); } },
				Prop::Setter(setter) => if let Some(body) = &setter.body { for statement in &body.stmts { collect_replacements_from_stmt(statement, context, replacements); } },
				_ => {}
			}
		},
		Expr::Paren(paren) => collect_replacements_from_expr(&paren.expr, context, replacements),
		Expr::Seq(sequence) => for expr in &sequence.exprs { collect_replacements_from_expr(expr, context, replacements); },
		Expr::Tpl(template) => {
			for expr in &template.exprs { collect_replacements_from_expr(expr, context, replacements); }
		}
		Expr::Unary(unary) => collect_replacements_from_expr(&unary.arg, context, replacements),
		Expr::Update(update) => collect_replacements_from_expr(&update.arg, context, replacements),
		_ => {}
	}
}

fn collect_replacements_from_pat_or_expr(left: &swc_ecma_ast::AssignTarget, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	match left {
		swc_ecma_ast::AssignTarget::Simple(simple) => match simple {
			swc_ecma_ast::SimpleAssignTarget::Ident(ident) => collect_replacements_from_ident(&ident.id, context, replacements),
			swc_ecma_ast::SimpleAssignTarget::Member(member) => collect_replacements_from_expr(&Expr::Member(member.clone()), context, replacements),
			swc_ecma_ast::SimpleAssignTarget::Paren(paren) => collect_replacements_from_expr(&paren.expr, context, replacements),
			_ => {}
		},
		swc_ecma_ast::AssignTarget::Pat(pat) => {
			let pat: Pat = pat.clone().into();
			collect_replacements_from_pat(&pat, context, replacements);
		}
	}
}

fn record_replacement(expr: &Expr, span: Span, context: &ReductionContext, replacements: &mut Vec<Replacement>) {
	let Some(value) = evaluate_constant_expression(expr, context, 0) else { return; };
	if is_literal_like(expr) {
		return;
	}
	let pass = reduction_pass(expr, context);
	let text = reduction_literal_text(&value);
	let Some(source) = span_slice(&context.source_text, span) else { return; };
	if text == source {
		return;
	}
	replacements.push(Replacement {
		start: span.lo.0.saturating_sub(1) as usize,
		end: span.hi.0.saturating_sub(1) as usize,
		text: text.clone(),
		from: truncate_preview(&source, 120),
		to: truncate_preview(&text, 120),
		pass,
	});
}

fn is_literal_like(expr: &Expr) -> bool {
	matches!(expr, Expr::Lit(Lit::Str(_) | Lit::Num(_) | Lit::Bool(_) | Lit::Null(_)))
}

fn reduction_pass(expr: &Expr, context: &ReductionContext) -> String {
	match expr {
		Expr::Ident(ident) if resolve_alias_name(&ident.sym.to_string(), &context.aliases) != ident.sym.to_string() => "aliasPropagation".to_string(),
		Expr::Member(member)
			if matches!(member.prop, MemberProp::Computed(_))
				&& ident_name(&member.obj).map(|name| context.candidate_values.contains_key(&resolve_alias_name(&name, &context.aliases))).unwrap_or(false)
				&& member.prop_as_expr().and_then(numeric_index_value).is_some() => "stringArrayElement".to_string(),
		Expr::Call(call_expr) if try_object_dispatch_call(call_expr, context, 0).is_some() => "objectDispatch".to_string(),
		Expr::Call(call_expr) if try_decode_call(call_expr, context).is_some() => "decoderCall".to_string(),
		_ => "constantExpression".to_string(),
	}
}

fn reduction_literal_text(value: &Value) -> String {
	match value {
		Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| format!("\"{}\"", text)),
		Value::Null => "null".to_string(),
		_ => value.to_string(),
	}
}

fn evaluate_constant_expression(expr: &Expr, context: &ReductionContext, depth: usize) -> Option<Value> {
	if depth > MAX_REDUCTION_DEPTH {
		return None;
	}
	match expr {
		Expr::Paren(paren) => evaluate_constant_expression(&paren.expr, context, depth + 1),
		Expr::Lit(Lit::Str(text)) => Some(Value::String(text.value.to_string_lossy().to_string())),
		Expr::Lit(Lit::Num(number)) => number_json(number.value),
		Expr::Lit(Lit::Bool(boolean)) => Some(Value::Bool(boolean.value)),
		Expr::Lit(Lit::Null(_)) => Some(Value::Null),
		Expr::Ident(ident) => evaluate_identifier(&ident.sym.to_string(), context, depth + 1),
		Expr::Member(member) if matches!(member.prop, MemberProp::Computed(_)) => {
			let name = ident_name(&member.obj)?;
			let values = context.candidate_values.get(&resolve_alias_name(&name, &context.aliases))?;
			let index = numeric_index_value(member.prop_as_expr()?)?;
			values.get(index).cloned().map(Value::String)
		}
		Expr::Call(call_expr) => try_object_dispatch_call(call_expr, context, depth + 1).or_else(|| try_decode_call(call_expr, context).map(Value::String)),
		Expr::Unary(unary) => evaluate_prefix(unary, context, depth + 1),
		Expr::Bin(bin_expr) => evaluate_binary(bin_expr, context, depth + 1),
		_ => None,
	}
}

fn evaluate_identifier(name: &str, context: &ReductionContext, depth: usize) -> Option<Value> {
	let resolved = resolve_alias_name(name, &context.aliases);
	if let Some(binding) = context.const_bindings.get(&resolved) {
		return evaluate_constant_expression(binding, context, depth + 1);
	}
	if resolved != name {
		return evaluate_identifier(&resolved, context, depth + 1);
	}
	None
}

fn evaluate_prefix(unary: &UnaryExpr, context: &ReductionContext, depth: usize) -> Option<Value> {
	let value = evaluate_constant_expression(&unary.arg, context, depth + 1)?;
	match unary.op {
		UnaryOp::Bang => Some(Value::Bool(!truthy(&value))),
		UnaryOp::Plus => number_value(&value).and_then(number_json),
		UnaryOp::Minus => number_value(&value).and_then(|number| number_json(-number)),
		UnaryOp::Tilde => Some(Value::Number((!(number_value(&value)? as i32) as i64).into())),
		_ => None,
	}
}

fn evaluate_binary(bin_expr: &BinExpr, context: &ReductionContext, depth: usize) -> Option<Value> {
	let left = evaluate_constant_expression(&bin_expr.left, context, depth + 1)?;
	let right = evaluate_constant_expression(&bin_expr.right, context, depth + 1)?;
	apply_binary_operator(bin_expr.op, &left, &right)
}

fn apply_binary_operator(op: BinaryOp, left: &Value, right: &Value) -> Option<Value> {
	match op {
		BinaryOp::Add => {
			if left.is_string() || right.is_string() {
				Some(Value::String(to_js_string(left) + to_js_string(right).as_str()))
			} else {
				number_json(number_value(left)? + number_value(right)?)
			}
		}
		BinaryOp::Sub => number_json(number_value(left)? - number_value(right)?),
		BinaryOp::Mul => number_json(number_value(left)? * number_value(right)?),
		BinaryOp::Div => number_json(number_value(left)? / number_value(right)?),
		BinaryOp::Mod => number_json(number_value(left)? % number_value(right)?),
		BinaryOp::Exp => number_json(number_value(left)?.powf(number_value(right)?)),
		BinaryOp::LogicalAnd => Some(if truthy(left) { right.clone() } else { left.clone() }),
		BinaryOp::LogicalOr => Some(if truthy(left) { left.clone() } else { right.clone() }),
		BinaryOp::NullishCoalescing => Some(if !left.is_null() { left.clone() } else { right.clone() }),
		BinaryOp::EqEqEq => Some(Value::Bool(left == right)),
		BinaryOp::NotEqEq => Some(Value::Bool(left != right)),
		BinaryOp::EqEq => Some(Value::Bool(loose_equal(left, right))),
		BinaryOp::NotEq => Some(Value::Bool(!loose_equal(left, right))),
		BinaryOp::Lt => Some(Value::Bool(number_value(left)? < number_value(right)?)),
		BinaryOp::LtEq => Some(Value::Bool(number_value(left)? <= number_value(right)?)),
		BinaryOp::Gt => Some(Value::Bool(number_value(left)? > number_value(right)?)),
		BinaryOp::GtEq => Some(Value::Bool(number_value(left)? >= number_value(right)?)),
		_ => None,
	}
}

fn try_decode_call(call_expr: &swc_ecma_ast::CallExpr, context: &ReductionContext) -> Option<String> {
	let callee = match &call_expr.callee {
		Callee::Expr(expr) => callee_name(expr),
		_ => None,
	}?;
	let array_name = context.known_decoders.get(&callee)?;
	let index = numeric_index_value(call_expr.args.first()?.expr.as_ref())?;
	context.candidate_values.get(array_name)?.get(index).cloned()
}

fn try_object_dispatch_call(call_expr: &swc_ecma_ast::CallExpr, context: &ReductionContext, depth: usize) -> Option<Value> {
	let (object_name, property_name) = object_dispatch_target(call_expr, &context.aliases)?;
	let expression = context.object_dispatch_map.get(&object_name)?.get(&property_name)?;
	evaluate_constant_expression(expression, context, depth + 1)
}

fn object_dispatch_target(call_expr: &swc_ecma_ast::CallExpr, aliases: &HashMap<String, String>) -> Option<(String, String)> {
	let Callee::Expr(expr) = &call_expr.callee else { return None; };
	let Expr::Member(member) = &**expr else { return None; };
	let object_name = resolve_alias_name(&ident_name(&member.obj)?, aliases);
	let property_name = if matches!(member.prop, MemberProp::Computed(_)) {
		string_literal_value(member.prop_as_expr()?).or_else(|| numeric_index_value(member.prop_as_expr()?).map(|value| value.to_string()))?
	} else {
		match &member.prop {
			MemberProp::Ident(ident) => ident.sym.to_string(),
			_ => return None,
		}
	};
	Some((object_name, property_name))
}

fn resolve_alias_name(name: &str, aliases: &HashMap<String, String>) -> String {
	let mut current = name.to_string();
	let mut seen = HashSet::from([current.clone()]);
	while let Some(next) = aliases.get(&current) {
		if seen.contains(next) {
			break;
		}
		current = next.clone();
		seen.insert(current.clone());
	}
	current
}

fn callee_name(expr: &Expr) -> Option<String> {
	match expr {
		Expr::Ident(ident) => Some(ident.sym.to_string()),
		Expr::Member(member) if matches!(member.prop, MemberProp::Ident(_)) => match &member.prop {
			MemberProp::Ident(ident) => Some(ident.sym.to_string()),
			_ => None,
		},
		Expr::Member(member) if matches!(member.prop, MemberProp::Computed(_)) => string_literal_value(member.prop_as_expr()?),
		_ => None,
	}
}

fn ident_name(expr: &Expr) -> Option<String> {
	match expr {
		Expr::Ident(ident) => Some(ident.sym.to_string()),
		_ => None,
	}
}

fn string_literal_value(expr: &Expr) -> Option<String> {
	match expr {
		Expr::Lit(Lit::Str(text)) => Some(text.value.to_string_lossy().to_string()),
		_ => None,
	}
}

fn numeric_index_value(expr: &Expr) -> Option<usize> {
	match expr {
		Expr::Lit(Lit::Num(number)) if number.value.fract() == 0.0 && number.value >= 0.0 => Some(number.value as usize),
		_ => None,
	}
}

fn number_value(value: &Value) -> Option<f64> {
	match value {
		Value::Number(number) => number.as_f64(),
		Value::Bool(boolean) => Some(if *boolean { 1.0 } else { 0.0 }),
		Value::String(text) => text.parse::<f64>().ok(),
		Value::Null => Some(0.0),
		_ => None,
	}
}

fn number_json(number: f64) -> Option<Value> {
	if !number.is_finite() {
		return None;
	}
	if number.fract() == 0.0 {
		let whole = number as i64;
		if (whole as f64) == number {
			return Some(Value::Number(whole.into()));
		}
	}
	serde_json::Number::from_f64(number).map(Value::Number)
}

fn to_js_string(value: &Value) -> String {
	match value {
		Value::String(text) => text.clone(),
		Value::Bool(boolean) => boolean.to_string(),
		Value::Number(number) => number.to_string(),
		Value::Null => "null".to_string(),
		_ => value.to_string(),
	}
}

fn truthy(value: &Value) -> bool {
	match value {
		Value::Bool(boolean) => *boolean,
		Value::Null => false,
		Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
		Value::String(text) => !text.is_empty(),
		Value::Array(_) | Value::Object(_) => true,
	}
}

fn loose_equal(left: &Value, right: &Value) -> bool {
	if left == right {
		return true;
	}
	match (left, right) {
		(Value::Number(a), Value::String(b)) | (Value::String(b), Value::Number(a)) => b.parse::<f64>().ok() == a.as_f64(),
		(Value::Bool(_), _) => loose_equal(&number_json(number_value(left).unwrap_or(0.0)).unwrap_or(Value::Null), right),
		(_, Value::Bool(_)) => loose_equal(left, &number_json(number_value(right).unwrap_or(0.0)).unwrap_or(Value::Null)),
		(Value::Null, Value::Null) => true,
		_ => false,
	}
}

fn span_slice(source_text: &str, span: Span) -> Option<String> {
	let start = span.lo.0.saturating_sub(1) as usize;
	let end = span.hi.0.saturating_sub(1) as usize;
	source_text.get(start..end).map(|text| text.to_string())
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
	if text.chars().count() <= max_chars {
		text.to_string()
	} else {
		text.chars().take(max_chars).collect()
	}
}

fn select_non_overlapping_replacements(mut replacements: Vec<Replacement>) -> Vec<Replacement> {
	replacements.sort_by(|a, b| (b.end - b.start).cmp(&(a.end - a.start)).then(a.start.cmp(&b.start)));
	let mut selected: Vec<Replacement> = Vec::new();
	for candidate in replacements {
		if selected.iter().any(|item| candidate.start < item.end && item.start < candidate.end) {
			continue;
		}
		selected.push(candidate);
	}
	selected.sort_by(|a, b| a.start.cmp(&b.start));
	selected
}

trait MemberExprExt {
	fn prop_as_expr(&self) -> Option<&Expr>;
}

impl MemberExprExt for MemberExpr {
	fn prop_as_expr(&self) -> Option<&Expr> {
		match &self.prop {
			MemberProp::Computed(computed) => Some(&computed.expr),
			_ => None,
		}
	}
}
