use std::collections::{HashMap, HashSet};
use std::io::{self, Read};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const MAX_TREE_DIFF_INSTANCES: usize = 20;
const MAX_TREE_DIFF_CHANGED_FIELDS: usize = 8;
const MAX_TREE_DIFF_SUMMARY_NAMES: usize = 6;
const MAX_TEMPLATES: usize = 12;
const MIN_TEMPLATE_INSTANCES: usize = 4;

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
