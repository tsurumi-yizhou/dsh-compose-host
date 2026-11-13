import { parseDocument, stringify, type ScalarTag } from 'yaml';
import { stringifyString } from 'yaml/util';

const expressionTag: ScalarTag = {
    tag: 'tag:yaml.org,2002:js',
    identify: (value): value is { __jsExpr: string } =>
        typeof value === 'object' && value !== null &&
        typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string',
    resolve: value => ({ __jsExpr: value }),
    stringify: (item, context, onComment, onChompKeep) => stringifyString(
        { ...item, value: (item.value as { __jsExpr: string }).__jsExpr },
        context, onComment, onChompKeep,
    ),
};

// Expressions remain data until the profile loader evaluates them.
export function loadProfileYaml(source: string): unknown {
    const document = parseDocument(source, { customTags: [expressionTag] });
    if (document.errors.length) throw document.errors[0];
    return document.toJS();
}

export function dumpProfileYaml(value: unknown): string {
    return stringify(value, { customTags: [expressionTag], aliasDuplicateObjects: false });
}
