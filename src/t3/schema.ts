// The two schema shapes TypeBox gave these tools that pi-schema builds differently: an open object (pi-schema's `obj` is
// closed by default; TypeBox's `Type.Object` was open) and a literal with its `type` (pi-schema's `lit` has none). Kept
// so the JSON Schema each tool shows the model is what it was before pi 1.5.
import { type Annotations, obj, type Properties, type Schema, type StaticObject } from "@earendil-works/pi-schema";

/** An object schema that allows properties it does not name, as TypeBox's `Type.Object` did. */
export function object<const P extends Properties>(properties: P, options: Annotations<StaticObject<P>> = {}): Schema<StaticObject<P>> {
	return obj(properties, { ...options, open: true }) as Schema<StaticObject<P>>;
}

/** A literal with its JSON type, as TypeBox's `Type.Literal` wrote it. */
export function literal<const V extends string | number | boolean>(value: V, options: Annotations<V> = {}): Schema<V> {
	return { ...options, type: typeof value, const: value } as unknown as Schema<V>;
}
