/**
 * Astrolabe — Design pattern catalog (#872).
 *
 * Static catalog of detectable design patterns with per-language
 * tree-sitter AST signatures. Each entry defines a pattern identity,
 * category, intent, and the S-expression queries needed to detect
 * structural evidence in source code.
 *
 * Query design principles:
 * - Specificity over vagueness: longer queries reduce false positives.
 * - Every query captures at least `@pattern_name` for the matched class/function.
 * - Confidence scoring: full structural (0.85), partial (0.6), name-only (0.4).
 * - Negative indicators reduce confidence when found in the same scope.
 */

import type { PatternDefinition } from '../language-definition.js';

// ── GoF Creational Patterns ─────────────────────────────────────────────────

const singleton: PatternDefinition = {
  id: 'gof-singleton',
  name: 'Singleton',
  category: 'gof-creational',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @return_type) (public_field_definition (accessibility_modifier) @access_mod name: (property_identifier) @field_name type: (type_identifier) @field_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^getInstance$/i },
        negativeIndicators: [
          `(class_declaration name: (type_identifier) body: (class_body (method_definition name: (property_identifier) @ctor (formal_parameters) @params)))`,
        ],
        minConfidence: 0.85,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (lexical_declaration (variable_declarator name: (identifier) @instance_name value: (new_expression type: (type_identifier) @inst_type)))) (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @ret_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^getInstance$/i },
        minConfidence: 0.85,
      },
      {
        query: `(lexical_declaration (variable_declarator name: (identifier) @pattern_name value: (new_expression type: (type_identifier) @inst_type)))`,
        requiredCaptures: ['pattern_name'],
        minConfidence: 0.4,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name) (public_field_definition name: (property_identifier) @field_name)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^getInstance$/i },
        minConfidence: 0.7,
      },
      {
        query: `(lexical_declaration (variable_declarator name: (identifier) @pattern_name value: (new_expression type: (identifier) @inst_type)))`,
        requiredCaptures: ['pattern_name'],
        minConfidence: 0.4,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @new_method) (assignment left: (identifier) @instance_var right: (call function: (attribute object: (identifier) @cls_name attribute: (identifier) @cls_method)))))`,
        requiredCaptures: ['pattern_name', 'new_method'],
        postFilters: { new_method: /^__new__$/ },
        minConfidence: 0.8,
      },
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @get_instance (parameter_list (identifier) @cls_param)) (assignment left: (identifier) @instance_var)))`,
        requiredCaptures: ['pattern_name', 'get_instance'],
        postFilters: { get_instance: /^get_instance$/i },
        minConfidence: 0.75,
      },
      {
        query: `(assignment left: (identifier) @pattern_name right: (call function: (identifier) @ctor_name))`,
        requiredCaptures: ['pattern_name'],
        minConfidence: 0.4,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_declaration (modifier) @static_mod type: (type_identifier) @return_type name: (identifier) @method_name) (constructor_declaration (modifier) @private_mod (formal_parameters))) (field_declaration (modifier) @field_static (variable_declarator name: (identifier) @field_name type: (type_identifier) @field_type)))`,
        requiredCaptures: ['pattern_name', 'method_name', 'private_mod', 'static_mod'],
        postFilters: { method_name: /^getInstance$/ },
        minConfidence: 0.85,
      },
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_declaration (modifier) @static_mod name: (identifier) @method_name (formal_parameters)) (field_declaration (modifier) @field_static (variable_declarator name: (identifier) @field_name))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^getInstance$/i },
        minConfidence: 0.7,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (property_declaration (modifier) @static_mod type: (identifier) @prop_type name: (identifier) @prop_name) (constructor_declaration (modifier) @private_mod (parameter_list))) (field_declaration (modifier) @field_static (variable_declarator name: (identifier) @field_name)))`,
        requiredCaptures: ['pattern_name', 'prop_name', 'private_mod', 'static_mod'],
        postFilters: { prop_name: /^Instance$/ },
        minConfidence: 0.85,
      },
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (property_declaration (modifier) @static_mod name: (identifier) @prop_name) (constructor_declaration (modifier) @private_mod (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'prop_name'],
        postFilters: { prop_name: /^Instance$/i },
        minConfidence: 0.7,
      },
    ],
  },
  intent: 'Ensure a class has only one instance and provide a global point of access to it.',
  participants: ['Singleton', 'Instance'],
  relatedPatterns: ['gof-abstract-factory', 'gof-builder'],
};

const factoryMethod: PatternDefinition = {
  id: 'gof-factory-method',
  name: 'Factory Method',
  category: 'gof-creational',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (implements_clause (type_identifier) @iface_name)) (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @return_type)))`,
        requiredCaptures: ['pattern_name', 'method_name', 'return_type'],
        minConfidence: 0.7,
      },
      {
        query: `(interface_declaration name: (type_identifier) @pattern_name body: (interface_body (property_signature name: (property_identifier) @method_name type: (type_identifier) @return_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.4,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (class_heritage (extends_clause (identifier) @base_name)) (method_definition name: (property_identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.5,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @method_name return_type: (type_identifier) @return_type) (function_definition name: (identifier) @sub_method return_type: (type_identifier) @sub_return_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.6,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_declaration (modifier) @abstract_mod type: (type_identifier) @return_type name: (identifier) @method_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'method_name', 'return_type'],
        minConfidence: 0.7,
      },
      {
        query: `(interface_declaration name: (identifier) @pattern_name body: (interface_body (method_declaration type: (type_identifier) @return_type name: (identifier) @method_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.5,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (method_declaration (modifier) @abstract_mod type: (identifier) @return_type name: (identifier) @method_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method_name', 'return_type'],
        minConfidence: 0.7,
      },
      {
        query: `(interface_declaration name: (identifier) @pattern_name body: (declaration_list (method_declaration type: (identifier) @return_type name: (identifier) @method_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.5,
      },
    ],
  },
  intent: 'Define an interface for creating an object, but let subclasses decide which class to instantiate.',
  participants: ['Creator', 'ConcreteCreator', 'Product', 'ConcreteProduct'],
  relatedPatterns: ['gof-abstract-factory', 'gof-prototype'],
};

const builder: PatternDefinition = {
  id: 'gof-builder',
  name: 'Builder',
  category: 'gof-creational',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @return_type) (method_definition name: (property_identifier) @method2_name return_type: (type_identifier) @return2_type) (method_definition name: (property_identifier) @build_name return_type: (type_identifier) @product_type)))`,
        requiredCaptures: ['pattern_name', 'method_name', 'build_name'],
        postFilters: { build_name: /^build$/i },
        minConfidence: 0.8,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @return_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.4,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name) (method_definition name: (property_identifier) @build_name)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { build_name: /^build$/i },
        minConfidence: 0.6,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @method_name return_type: (type_identifier) @return_type) (function_definition name: (identifier) @method2_name return_type: (type_identifier) @return2_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { return_type: /^Self$/i },
        minConfidence: 0.75,
      },
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @method_name (return_statement (identifier) @self_ref)))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.5,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_declaration type: (type_identifier) @return_type name: (identifier) @method_name (formal_parameters)) (method_declaration type: (type_identifier) @return2_type name: (identifier) @method2_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.5,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (method_declaration type: (identifier) @return_type name: (identifier) @method_name (parameter_list)) (method_declaration type: (identifier) @return2_type name: (identifier) @build_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { build_name: /^Build$/ },
        minConfidence: 0.7,
      },
    ],
  },
  intent: 'Separate the construction of a complex object from its representation so the same construction process can create different representations.',
  participants: ['Builder', 'ConcreteBuilder', 'Director', 'Product'],
  relatedPatterns: ['gof-abstract-factory', 'gof-singleton'],
};

const abstractFactory: PatternDefinition = {
  id: 'gof-abstract-factory',
  name: 'Abstract Factory',
  category: 'gof-creational',
  languages: {
    typescript: [
      {
        query: `(interface_declaration name: (type_identifier) @pattern_name body: (interface_body (property_signature name: (property_identifier) @method1_name type: (type_identifier) @return1_type) (property_signature name: (property_identifier) @method2_name type: (type_identifier) @return2_type)))`,
        requiredCaptures: ['pattern_name', 'method1_name', 'method2_name'],
        minConfidence: 0.6,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (implements_clause (type_identifier) @iface_name)) (method_definition name: (property_identifier) @method1_name return_type: (type_identifier) @ret1) (method_definition name: (property_identifier) @method2_name return_type: (type_identifier) @ret2)))`,
        requiredCaptures: ['pattern_name', 'method1_name', 'method2_name'],
        minConfidence: 0.7,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @method1_name return_type: (type_identifier) @return1_type) (function_definition name: (identifier) @method2_name return_type: (type_identifier) @return2_type)))`,
        requiredCaptures: ['pattern_name', 'method1_name', 'method2_name'],
        minConfidence: 0.55,
      },
    ],
    java: [
      {
        query: `(interface_declaration name: (identifier) @pattern_name body: (interface_body (method_declaration type: (type_identifier) @return1_type name: (identifier) @method1_name (formal_parameters)) (method_declaration type: (type_identifier) @return2_type name: (identifier) @method2_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'method1_name', 'method2_name'],
        minConfidence: 0.6,
      },
    ],
    csharp: [
      {
        query: `(interface_declaration name: (identifier) @pattern_name body: (declaration_list (method_declaration type: (identifier) @return1_type name: (identifier) @method1_name (parameter_list)) (method_declaration type: (identifier) @return2_type name: (identifier) @method2_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method1_name', 'method2_name'],
        minConfidence: 0.6,
      },
    ],
  },
  intent: 'Provide an interface for creating families of related or dependent objects without specifying their concrete classes.',
  participants: ['AbstractFactory', 'ConcreteFactory', 'AbstractProduct', 'ConcreteProduct'],
  relatedPatterns: ['gof-factory-method', 'gof-prototype'],
};

const prototype: PatternDefinition = {
  id: 'gof-prototype',
  name: 'Prototype',
  category: 'gof-creational',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name return_type: (type_identifier) @return_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^clone$/ },
        minConfidence: 0.85,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^clone$/ },
        minConfidence: 0.75,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^(__copy__|__deepcopy__|clone)$/ },
        minConfidence: 0.85,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_declaration type: (type_identifier) @return_type name: (identifier) @method_name (formal_parameters)) (superclass (type_identifier) @super_name)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^clone$/ },
        minConfidence: 0.7,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (base_list (type_identifier) @base_name) body: (declaration_list (method_declaration type: (identifier) @return_type name: (identifier) @method_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^Clone$/ },
        minConfidence: 0.7,
      },
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (method_declaration type: (identifier) @return_type name: (identifier) @method_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^Clone$/ },
        minConfidence: 0.85,
      },
    ],
  },
  intent: 'Specify the kinds of objects to create using a prototypical instance, and create new objects by copying this prototype.',
  participants: ['Prototype', 'ConcretePrototype'],
  relatedPatterns: ['gof-abstract-factory', 'gof-factory-method'],
};

// ── GoF Structural Patterns ─────────────────────────────────────────────────

const adapter: PatternDefinition = {
  id: 'gof-adapter',
  name: 'Adapter',
  category: 'gof-structural',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (implements_clause (type_identifier) @target_iface)) (public_field_definition name: (property_identifier) @adaptee_field type: (type_identifier) @adaptee_type)) (method_definition name: (property_identifier) @method_name) (constructor (formal_parameters required: (required_parameter pattern: (identifier) @param_name type: (type_identifier) @param_type)))))`,
        requiredCaptures: ['pattern_name', 'target_iface', 'method_name'],
        minConfidence: 0.8,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (implements_clause (type_identifier) @target_iface)) (method_definition name: (property_identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'target_iface'],
        minConfidence: 0.55,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (class_heritage (extends_clause (identifier) @base_name)) (method_definition name: (property_identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'base_name'],
        minConfidence: 0.45,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name (argument_list (identifier) @base_name) body: (block (function_definition name: (identifier) @init_method (default_parameter (identifier) @adaptee_param)) (function_definition name: (identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'base_name'],
        minConfidence: 0.6,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (super_interfaces (type_list (type_identifier) @target_iface)) body: (class_body (field_declaration type: (type_identifier) @adaptee_type (variable_declarator name: (identifier) @adaptee_field)) (constructor_declaration (formal_parameters (formal_parameter type: (type_identifier) @param_type))) (method_declaration name: (identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'target_iface', 'method_name'],
        minConfidence: 0.8,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (base_list (type_identifier) @target_iface) body: (declaration_list (field_declaration type: (identifier) @adaptee_type (variable_declarator name: (identifier) @adaptee_field)) (constructor_declaration (parameter_list (parameter type: (identifier) @param_type))) (method_declaration name: (identifier) @method_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'target_iface', 'method_name'],
        minConfidence: 0.8,
      },
    ],
  },
  intent: 'Convert the interface of a class into another interface clients expect. Lets classes work together that couldn\'t otherwise because of incompatible interfaces.',
  participants: ['Target', 'Adapter', 'Adaptee'],
  relatedPatterns: ['gof-decorator', 'gof-facade', 'gof-proxy'],
};

const decorator: PatternDefinition = {
  id: 'gof-decorator',
  name: 'Decorator',
  category: 'gof-structural',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (implements_clause (type_identifier) @iface_name))) (public_field_definition name: (property_identifier) @wrapped_field type: (type_identifier) @wrapped_type) (method_definition name: (property_identifier) @method_name) (constructor (formal_parameters required: (required_parameter pattern: (identifier) @param_name type: (type_identifier) @param_type)))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'wrapped_field', 'method_name'],
        minConfidence: 0.85,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (extends_clause (type_identifier) @base_name)) (public_field_definition name: (property_identifier) @wrapped_field type: (type_identifier) @wrapped_type) (constructor (formal_parameters required: (required_parameter pattern: (identifier) @param_name type: (type_identifier) @param_type))) (method_definition name: (property_identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'base_name', 'wrapped_field'],
        minConfidence: 0.85,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (class_heritage (extends_clause (identifier) @base_name)) (constructor (formal_parameters (identifier) @param_name)) (method_definition name: (property_identifier) @method_name) (public_field_definition name: (property_identifier) @field_name)))`,
        requiredCaptures: ['pattern_name', 'base_name', 'field_name'],
        minConfidence: 0.6,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name (argument_list (identifier) @base_name) body: (block (function_definition name: (identifier) @init_method parameters: (parameters (identifier) @self_param (identifier) @component_param)) (function_definition name: (identifier) @method_name (block (expression_statement (call function: (attribute object: (identifier) @delegated_target attribute: (identifier) @delegated_method))))))))`,
        requiredCaptures: ['pattern_name', 'base_name', 'method_name'],
        minConfidence: 0.7,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (super_interfaces (type_list (type_identifier) @iface_name)) body: (class_body (field_declaration type: (type_identifier) @wrapped_type (variable_declarator name: (identifier) @wrapped_field)) (constructor_declaration (formal_parameters (formal_parameter type: (type_identifier) @param_type)))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'wrapped_field'],
        minConfidence: 0.8,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (base_list (type_identifier) @iface_name) body: (declaration_list (field_declaration type: (identifier) @wrapped_type (variable_declarator name: (identifier) @wrapped_field)) (constructor_declaration (parameter_list (parameter type: (identifier) @param_type)))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'wrapped_field'],
        minConfidence: 0.8,
      },
    ],
  },
  intent: 'Attach additional responsibilities to an object dynamically. Provides a flexible alternative to subclassing for extending functionality.',
  participants: ['Component', 'Decorator', 'ConcreteDecorator', 'ConcreteComponent'],
  relatedPatterns: ['gof-adapter', 'gof-strategy', 'gof-composite'],
};

const facade: PatternDefinition = {
  id: 'gof-facade',
  name: 'Facade',
  category: 'gof-structural',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method1_name) (method_definition name: (property_identifier) @method2_name) (public_field_definition name: (property_identifier) @subsys1 type: (type_identifier) @subsys1_type) (public_field_definition name: (property_identifier) @subsys2 type: (type_identifier) @subsys2_type))))`,
        requiredCaptures: ['pattern_name', 'method1_name', 'subsys1_type', 'subsys2_type'],
        minConfidence: 0.7,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method1_name) (method_definition name: (property_identifier) @method2_name) (public_field_definition name: (property_identifier) @field1_name) (public_field_definition name: (property_identifier) @field2_name)))`,
        requiredCaptures: ['pattern_name', 'method1_name'],
        minConfidence: 0.45,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @init_method parameters: (parameters (identifier) @self (identifier) @sub1 (identifier) @sub2)) (function_definition name: (identifier) @method1_name) (function_definition name: (identifier) @method2_name)))`,
        requiredCaptures: ['pattern_name', 'method1_name'],
        minConfidence: 0.5,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (field_declaration type: (type_identifier) @sub1_type (variable_declarator name: (identifier) @sub1_name)) (field_declaration type: (type_identifier) @sub2_type (variable_declarator name: (identifier) @sub2_name)) (method_declaration name: (identifier) @method1_name (formal_parameters)) (method_declaration name: (identifier) @method2_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'method1_name'],
        minConfidence: 0.6,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (field_declaration type: (identifier) @sub1_type (variable_declarator name: (identifier) @sub1_name)) (field_declaration type: (identifier) @sub2_type (variable_declarator name: (identifier) @sub2_name)) (method_declaration name: (identifier) @method1_name (parameter_list)) (method_declaration name: (identifier) @method2_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method1_name'],
        minConfidence: 0.6,
      },
    ],
  },
  intent: 'Provide a unified interface to a set of interfaces in a subsystem. Defines a higher-level interface that makes the subsystem easier to use.',
  participants: ['Facade', 'Subsystem'],
  relatedPatterns: ['gof-adapter', 'gof-abstract-factory', 'gof-mediator'],
};

const proxy: PatternDefinition = {
  id: 'gof-proxy',
  name: 'Proxy',
  category: 'gof-structural',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (implements_clause (type_identifier) @iface_name)) (public_field_definition name: (property_identifier) @subject_field type: (type_identifier) @subject_type) (method_definition name: (property_identifier) @method_name) (constructor (formal_parameters required: (required_parameter pattern: (identifier) @param_name type: (type_identifier) @param_type)))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'subject_field'],
        minConfidence: 0.75,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (class_heritage (extends_clause (identifier) @base_name)) (constructor (formal_parameters (identifier) @param_name)) (public_field_definition name: (property_identifier) @field_name) (method_definition name: (property_identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'base_name', 'field_name'],
        minConfidence: 0.55,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name (argument_list (identifier) @base_name) body: (block (function_definition name: (identifier) @init_method parameters: (parameters (identifier) @self (identifier) @real_param)) (function_definition name: (identifier) @method_name (block (expression_statement (call function: (attribute object: (identifier) @delegated_target attribute: (identifier) @delegated_method))))))))`,
        requiredCaptures: ['pattern_name', 'base_name', 'method_name'],
        minConfidence: 0.65,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (super_interfaces (type_list (type_identifier) @iface_name)) body: (class_body (field_declaration type: (type_identifier) @subject_type (variable_declarator name: (identifier) @subject_field)) (method_declaration name: (identifier) @method_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'subject_field'],
        minConfidence: 0.7,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (base_list (type_identifier) @iface_name) body: (declaration_list (field_declaration type: (identifier) @subject_type (variable_declarator name: (identifier) @subject_field)) (method_declaration name: (identifier) @method_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'subject_field'],
        minConfidence: 0.7,
      },
    ],
  },
  intent: 'Provide a surrogate or placeholder for another object to control access to it.',
  participants: ['Subject', 'Proxy', 'RealSubject'],
  relatedPatterns: ['gof-adapter', 'gof-decorator'],
};

const composite: PatternDefinition = {
  id: 'gof-composite',
  name: 'Composite',
  category: 'gof-structural',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (implements_clause (type_identifier) @iface_name)) (public_field_definition name: (property_identifier) @children_field type: (array_type element_type: (type_identifier) @element_type)) (method_definition name: (property_identifier) @add_name) (method_definition name: (property_identifier) @remove_name) (method_definition name: (property_identifier) @op_name))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'children_field'],
        minConfidence: 0.85,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (public_field_definition name: (property_identifier) @children_field type: (array_type)) (method_definition name: (property_identifier) @add_name) (method_definition name: (property_identifier) @op_name)))`,
        requiredCaptures: ['pattern_name', 'children_field'],
        minConfidence: 0.55,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (public_field_definition name: (property_identifier) @field_name) (method_definition name: (property_identifier) @add_name) (method_definition name: (property_identifier) @op_name)))`,
        requiredCaptures: ['pattern_name', 'add_name'],
        minConfidence: 0.45,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name (argument_list (identifier) @base_name) body: (block (function_definition name: (identifier) @add_name parameters: (parameters (identifier) @self (identifier) @child)) (function_definition name: (identifier) @remove_name) (function_definition name: (identifier) @op_name)))`,
        requiredCaptures: ['pattern_name', 'base_name', 'add_name'],
        minConfidence: 0.6,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (super_interfaces (type_list (type_identifier) @iface_name)) body: (class_body (field_declaration type: (type_identifier) @list_type (variable_declarator name: (identifier) @children_field)) (method_declaration name: (identifier) @add_name (formal_parameters)) (method_declaration name: (identifier) @remove_name (formal_parameters)) (method_declaration name: (identifier) @op_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'children_field'],
        minConfidence: 0.8,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name (base_list (type_identifier) @iface_name) body: (declaration_list (field_declaration type: (identifier) @list_type (variable_declarator name: (identifier) @children_field)) (method_declaration name: (identifier) @add_name (parameter_list)) (method_declaration name: (identifier) @remove_name (parameter_list)) (method_declaration name: (identifier) @op_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'iface_name', 'children_field'],
        minConfidence: 0.8,
      },
    ],
  },
  intent: 'Compose objects into tree structures to represent part-whole hierarchies. Lets clients treat individual objects and compositions uniformly.',
  participants: ['Component', 'Composite', 'Leaf'],
  relatedPatterns: ['gof-decorator', 'gof-visitor', 'gof-iterator'],
};

// ── GoF Behavioral Patterns ─────────────────────────────────────────────────

const strategy: PatternDefinition = {
  id: 'gof-strategy',
  name: 'Strategy',
  category: 'gof-behavioral',
  languages: {
    typescript: [
      {
        query: `(interface_declaration name: (type_identifier) @pattern_name body: (interface_body (property_signature name: (property_identifier) @method_name type: (type_identifier) @return_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        minConfidence: 0.4,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (public_field_definition name: (property_identifier) @strategy_field type: (type_identifier) @strategy_type) (method_definition name: (property_identifier) @context_method body: (statement_block (call_expression function: (member_expression object: (property_identifier) @field_ref property: (property_identifier) @strategy_call)))))))`,
        requiredCaptures: ['pattern_name', 'strategy_field'],
        minConfidence: 0.7,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (constructor (formal_parameters (identifier) @strategy_param)) (public_field_definition name: (property_identifier) @strategy_field) (method_definition name: (property_identifier) @context_method body: (statement_block (expression_statement (call_expression function: (member_expression object: (property_identifier) @field_ref property: (property_identifier) @strategy_call))))))))`,
        requiredCaptures: ['pattern_name', 'strategy_field'],
        minConfidence: 0.6,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @init_method parameters: (parameters (identifier) @self (identifier) @strategy_param)) (function_definition name: (identifier) @exec_method (block (expression_statement (call function: (attribute object: (identifier) @strategy_ref attribute: (identifier) @strategy_fn))))))))`,
        requiredCaptures: ['pattern_name', 'strategy_param'],
        minConfidence: 0.65,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (field_declaration type: (type_identifier) @strategy_type (variable_declarator name: (identifier) @strategy_field)) (constructor_declaration (formal_parameters (formal_parameter type: (type_identifier) @param_type))) (method_declaration name: (identifier) @context_method (formal_parameters) body: (block (expression_statement (method_invocation object: (identifier) @field_ref name: (identifier) @strategy_call (argument_list)))))))`,
        requiredCaptures: ['pattern_name', 'strategy_field'],
        minConfidence: 0.7,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (field_declaration type: (identifier) @strategy_type (variable_declarator name: (identifier) @strategy_field)) (constructor_declaration (parameter_list (parameter type: (identifier) @param_type))) (method_declaration name: (identifier) @context_method (parameter_list) body: (block (expression_statement (invocation_expression function: (member_access_expression object: (identifier) @field_ref name: (identifier) @strategy_call (argument_list))))))))`,
        requiredCaptures: ['pattern_name', 'strategy_field'],
        minConfidence: 0.7,
      },
    ],
  },
  intent: 'Define a family of algorithms, encapsulate each one, and make them interchangeable. Lets the algorithm vary independently from clients that use it.',
  participants: ['Strategy', 'ConcreteStrategy', 'Context'],
  relatedPatterns: ['gof-state', 'gof-template-method', 'gof-command'],
};

const observer: PatternDefinition = {
  id: 'gof-observer',
  name: 'Observer',
  category: 'gof-behavioral',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @subscribe_name) (method_definition name: (property_identifier) @notify_name) (public_field_definition name: (property_identifier) @listeners_field type: (array_type))))`,
        requiredCaptures: ['pattern_name', 'subscribe_name', 'notify_name'],
        minConfidence: 0.85,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @sub_name) (method_definition name: (property_identifier) @notif_name)))`,
        requiredCaptures: ['pattern_name', 'sub_name'],
        postFilters: { sub_name: /^(subscribe|on|addListener|attach|addObserver)$/i },
        minConfidence: 0.6,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @sub_name) (method_definition name: (property_identifier) @notif_name) (public_field_definition name: (property_identifier) @field_name)))`,
        requiredCaptures: ['pattern_name', 'sub_name'],
        postFilters: { sub_name: /^(subscribe|on|addListener|attach)$/i },
        minConfidence: 0.6,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @attach_name parameters: (parameters (identifier) @self (identifier) @observer)) (function_definition name: (identifier) @notify_name parameters: (parameters (identifier) @self))))`,
        requiredCaptures: ['pattern_name', 'attach_name', 'notify_name'],
        minConfidence: 0.65,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (field_declaration (variable_declarator name: (identifier) @listeners_field)) (method_declaration name: (identifier) @add_name (formal_parameters (formal_parameter type: (type_identifier) @listener_type))) (method_declaration name: (identifier) @notify_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'add_name'],
        postFilters: { add_name: /^(add|addListener|attach|addObserver|subscribe)$/i },
        minConfidence: 0.65,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (field_declaration (variable_declarator name: (identifier) @listeners_field)) (method_declaration name: (identifier) @add_name (parameter_list (parameter type: (identifier) @listener_type))) (method_declaration name: (identifier) @notify_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'add_name'],
        postFilters: { add_name: /^(Add|Attach|Subscribe)$/ },
        minConfidence: 0.65,
      },
    ],
  },
  intent: 'Define a one-to-many dependency between objects so when one object changes state, all dependents are notified and updated automatically.',
  participants: ['Subject', 'Observer', 'ConcreteSubject', 'ConcreteObserver'],
  relatedPatterns: ['gof-strategy', 'gof-mediator', 'gof-singleton'],
};

const command: PatternDefinition = {
  id: 'gof-command',
  name: 'Command',
  category: 'gof-behavioral',
  languages: {
    typescript: [
      {
        query: `(interface_declaration name: (type_identifier) @pattern_name body: (interface_body (property_signature name: (property_identifier) @method_name type: (type_identifier) @return_type)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^execute$/i },
        minConfidence: 0.6,
      },
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (class_heritage (implements_clause (type_identifier) @iface_name)) (method_definition name: (property_identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^execute$/i },
        minConfidence: 0.75,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @method_name)))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^execute$/i },
        minConfidence: 0.45,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @method_name parameters: (parameters (identifier) @self_param))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^execute$/i },
        minConfidence: 0.5,
      },
    ],
    java: [
      {
        query: `(interface_declaration name: (identifier) @pattern_name body: (interface_body (method_declaration type: (type_identifier) @return_type name: (identifier) @method_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^execute$/i },
        minConfidence: 0.6,
      },
      {
        query: `(class_declaration name: (identifier) @pattern_name (super_interfaces (type_list (type_identifier) @iface_name)) body: (class_body (method_declaration name: (identifier) @method_name (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^execute$/i },
        minConfidence: 0.7,
      },
    ],
    csharp: [
      {
        query: `(interface_declaration name: (identifier) @pattern_name body: (declaration_list (method_declaration type: (identifier) @return_type name: (identifier) @method_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^Execute$/ },
        minConfidence: 0.6,
      },
      {
        query: `(class_declaration name: (identifier) @pattern_name (base_list (type_identifier) @iface_name) body: (declaration_list (method_declaration name: (identifier) @method_name (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'method_name'],
        postFilters: { method_name: /^Execute$/ },
        minConfidence: 0.7,
      },
    ],
  },
  intent: 'Encapsulate a request as an object, thereby letting you parameterize clients with different requests, queue or log requests, and support undoable operations.',
  participants: ['Command', 'ConcreteCommand', 'Invoker', 'Receiver'],
  relatedPatterns: ['gof-strategy', 'gof-observer', 'gof-state'],
};

const templateMethod: PatternDefinition = {
  id: 'gof-template-method',
  name: 'Template Method',
  category: 'gof-behavioral',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @template_method body: (statement_block (call_expression function: (member_expression object: (property_identifier) @this_ref property: (property_identifier) @hook_name))))) (method_definition name: (property_identifier) @hook_method1)))`,
        requiredCaptures: ['pattern_name', 'template_method', 'hook_name'],
        minConfidence: 0.8,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_definition name: (property_identifier) @template_method body: (statement_block (expression_statement (call_expression function: (member_expression object: (this) @this_ref property: (property_identifier) @hook_name))))))))`,
        requiredCaptures: ['pattern_name', 'template_method'],
        minConfidence: 0.7,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @template_method parameters: (parameters (identifier) @self) body: (block (expression_statement (call function: (attribute object: (identifier) @self_ref attribute: (identifier) @hook_name)))))))`,
        requiredCaptures: ['pattern_name', 'template_method'],
        minConfidence: 0.7,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (method_declaration (modifier) @final_mod name: (identifier) @template_method body: (block (expression_statement (method_invocation object: (identifier) @this_ref name: (identifier) @hook_name (argument_list))))) (method_declaration (modifier) @abstract_mod name: (identifier) @hook_method (formal_parameters))))`,
        requiredCaptures: ['pattern_name', 'template_method', 'final_mod'],
        minConfidence: 0.85,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (method_declaration (modifier) @virtual_mod name: (identifier) @template_method body: (block (expression_statement (invocation_expression function: (member_access_expression object: (identifier) @this_ref name: (identifier) @hook_name (argument_list)))))) (method_declaration (modifier) @abstract_mod name: (identifier) @hook_method (parameter_list))))`,
        requiredCaptures: ['pattern_name', 'template_method', 'abstract_mod'],
        minConfidence: 0.85,
      },
    ],
  },
  intent: 'Define the skeleton of an algorithm in an operation, deferring some steps to subclasses. Lets subclasses redefine certain steps without changing the algorithm\'s structure.',
  participants: ['AbstractClass', 'ConcreteClass'],
  relatedPatterns: ['gof-strategy', 'gof-factory-method'],
};

const state: PatternDefinition = {
  id: 'gof-state',
  name: 'State',
  category: 'gof-behavioral',
  languages: {
    typescript: [
      {
        query: `(class_declaration name: (type_identifier) @pattern_name body: (class_body (public_field_definition name: (property_identifier) @state_field type: (type_identifier) @state_type) (method_definition name: (property_identifier) @context_method body: (statement_block (call_expression function: (member_expression object: (property_identifier) @state_ref property: (property_identifier) @state_method)))))))`,
        requiredCaptures: ['pattern_name', 'state_field'],
        minConfidence: 0.7,
      },
      {
        query: `(interface_declaration name: (type_identifier) @pattern_name body: (interface_body (property_signature name: (property_identifier) @method1_name type: (type_identifier) @return1) (property_signature name: (property_identifier) @method2_name type: (type_identifier) @return2)))`,
        requiredCaptures: ['pattern_name', 'method1_name', 'method2_name'],
        minConfidence: 0.4,
      },
    ],
    javascript: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (constructor (formal_parameters (identifier) @state_param)) (method_definition name: (property_identifier) @context_method body: (statement_block (expression_statement (call_expression function: (member_expression object: (property_identifier) @state_ref property: (property_identifier) @state_method))))))))`,
        requiredCaptures: ['pattern_name', 'state_param'],
        minConfidence: 0.6,
      },
    ],
    python: [
      {
        query: `(class_definition name: (identifier) @pattern_name body: (block (function_definition name: (identifier) @init_method parameters: (parameters (identifier) @self (identifier) @state_param)) (function_definition name: (identifier) @context_method (block (expression_statement (call function: (attribute object: (attribute object: (identifier) @self_ref attribute: (identifier) @state_attr) attribute: (identifier) @state_method))))))))`,
        requiredCaptures: ['pattern_name', 'state_param'],
        minConfidence: 0.65,
      },
    ],
    java: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (class_body (field_declaration type: (type_identifier) @state_type (variable_declarator name: (identifier) @state_field)) (method_declaration name: (identifier) @set_state (formal_parameters (formal_parameter type: (type_identifier) @param_type))) (method_declaration name: (identifier) @context_method (formal_parameters) body: (block (expression_statement (method_invocation object: (identifier) @state_ref name: (identifier) @state_method (argument_list)))))))`,
        requiredCaptures: ['pattern_name', 'state_field', 'set_state'],
        minConfidence: 0.75,
      },
    ],
    csharp: [
      {
        query: `(class_declaration name: (identifier) @pattern_name body: (declaration_list (field_declaration type: (identifier) @state_type (variable_declarator name: (identifier) @state_field)) (property_declaration type: (identifier) @prop_type name: (identifier) @state_prop) (method_declaration name: (identifier) @context_method (parameter_list) body: (block (expression_statement (invocation_expression function: (member_access_expression object: (identifier) @state_ref name: (identifier) @state_method (argument_list))))))))`,
        requiredCaptures: ['pattern_name', 'state_field'],
        minConfidence: 0.7,
      },
    ],
  },
  intent: 'Allow an object to alter its behavior when its internal state changes. The object will appear to change its class.',
  participants: ['Context', 'State', 'ConcreteState'],
  relatedPatterns: ['gof-strategy', 'gof-flyweight'],
};

// ── Language Idioms ─────────────────────────────────────────────────────────

const goConcurrency: PatternDefinition = {
  id: 'idiom-go-concurrency',
  name: 'Go Concurrency',
  category: 'idiom',
  languages: {
    go: [
      {
        query: `(function_declaration name: (identifier) @pattern_name body: (block (go_statement (func_literal)) (send_statement channel: (identifier) @ch_var)))`,
        requiredCaptures: ['pattern_name'],
        minConfidence: 0.85,
      },
      {
        query: `(function_declaration name: (identifier) @pattern_name body: (block (go_statement (func_literal))))`,
        requiredCaptures: ['pattern_name'],
        minConfidence: 0.4,
      },
    ],
  },
  intent: 'Go idiomatic concurrency using goroutines and channels for communicating sequential processes.',
  participants: ['Goroutine', 'Channel'],
  relatedPatterns: ['gof-observer'],
};

const rustTraitImpl: PatternDefinition = {
  id: 'idiom-rust-trait-impl',
  name: 'Rust Trait Implementation',
  category: 'idiom',
  languages: {
    rust: [
      {
        query: `(impl_item type: (type_identifier) @trait_name body: (declaration_list (function_item name: (identifier) @method1_name) (function_item name: (identifier) @method2_name)))`,
        requiredCaptures: ['trait_name', 'method1_name', 'method2_name'],
        minConfidence: 0.7,
      },
      {
        query: `(impl_item type: (type_identifier) @trait_name body: (declaration_list (function_item name: (identifier) @method_name)))`,
        requiredCaptures: ['trait_name', 'method_name'],
        minConfidence: 0.4,
      },
    ],
  },
  intent: 'Rust trait implementation pattern — implementing a trait for a type with one or more method definitions.',
  participants: ['Trait', 'Type', 'MethodImpl'],
  relatedPatterns: ['gof-strategy', 'gof-adapter'],
};

const pythonDecorator: PatternDefinition = {
  id: 'idiom-python-decorator',
  name: 'Python Decorator Pattern',
  category: 'idiom',
  languages: {
    python: [
      {
        query: `(decorator (call function: (identifier) @decorator_name) (function_definition name: (identifier) @func_name body: (block (function_definition name: (identifier) @wrapper_name) (return_statement (identifier) @return_ref)))))`,
        requiredCaptures: ['decorator_name', 'func_name', 'wrapper_name'],
        minConfidence: 0.85,
      },
      {
        query: `(decorator (identifier) @decorator_name) (function_definition name: (identifier) @func_name body: (block (function_definition name: (identifier) @inner_name) (return_statement (identifier) @return_ref))))`,
        requiredCaptures: ['decorator_name', 'func_name'],
        minConfidence: 0.6,
      },
    ],
  },
  intent: 'Python decorator pattern — wrapping a function to add behavior, typically using a closure-based decorator with an inner wrapper function.',
  participants: ['Decorator', 'WrappedFunction', 'Wrapper'],
  relatedPatterns: ['gof-decorator'],
};

const csharpAsync: PatternDefinition = {
  id: 'idiom-csharp-async',
  name: 'C# Async Pattern',
  category: 'idiom',
  languages: {
    csharp: [
      {
        query: `(method_declaration (modifier) @async_mod name: (identifier) @pattern_name body: (block (expression_statement (await_expression (identifier) @awaited_task)))))`,
        requiredCaptures: ['pattern_name', 'async_mod'],
        postFilters: { async_mod: /^async$/ },
        minConfidence: 0.85,
      },
      {
        query: `(method_declaration (modifier) @async_mod name: (identifier) @pattern_name body: (block (return_statement (await_expression (identifier) @awaited_task)))))`,
        requiredCaptures: ['pattern_name', 'async_mod'],
        postFilters: { async_mod: /^async$/ },
        minConfidence: 0.85,
      },
      {
        query: `(method_declaration (modifier) @async_mod name: (identifier) @pattern_name)`,
        requiredCaptures: ['pattern_name', 'async_mod'],
        postFilters: { async_mod: /^async$/ },
        minConfidence: 0.4,
      },
    ],
  },
  intent: 'C# async/await pattern — marking a method as async and awaiting Task-based operations within it.',
  participants: ['AsyncMethod', 'AwaitedTask'],
  relatedPatterns: ['idiom-go-concurrency'],
};

// ── Catalog Assembly ─────────────────────────────────────────────────────────

export const PATTERN_CATALOG: PatternDefinition[] = [
  // GoF Creational
  singleton,
  factoryMethod,
  builder,
  abstractFactory,
  prototype,

  // GoF Structural
  adapter,
  decorator,
  facade,
  proxy,
  composite,

  // GoF Behavioral
  strategy,
  observer,
  command,
  templateMethod,
  state,

  // Language Idioms
  goConcurrency,
  rustTraitImpl,
  pythonDecorator,
  csharpAsync,
];

/** Get all pattern definitions that have signatures for a given language. */
export function getPatternsForLanguage(language: string): PatternDefinition[] {
  return PATTERN_CATALOG.filter(
    (p) => p.languages[language] && p.languages[language]!.length > 0,
  );
}

/** Look up a pattern definition by its unique ID. */
export function getPatternById(id: string): PatternDefinition | undefined {
  return PATTERN_CATALOG.find((p) => p.id === id);
}
