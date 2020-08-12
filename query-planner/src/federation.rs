use crate::context::FieldSet;
use graphql_parser::schema::{Field, ObjectType, TypeDefinition};

pub struct FederationMetadata<'q> {
    pub service_name: &'q str,
}

impl<'q> FederationMetadata<'q> {
    pub fn is_value_type(&self) -> bool {
        unimplemented!()
    }
}

pub enum SchemaRef<'q> {
    FieldDef(&'q Field<'q>),
    TypeDef(&'q TypeDefinition<'q>),
    ObjType(&'q ObjectType<'q>),
}

macro_rules! impl_from {
    // This implements `From` for all inner types of SchemaRef,
    // so that get_federation_metadata can be called directly with any of those types.
    ($typ:ident < $lt:lifetime >, $enum_name:ident) => {
        impl<$lt> From<&$lt$typ<$lt>> for SchemaRef<$lt> {
            fn from(r: &$lt$typ<$lt>) -> Self {
                SchemaRef::$enum_name(r)
            }
        }
    }
}

impl_from!(Field<'q>, FieldDef);
impl_from!(TypeDefinition<'q>, TypeDef);
impl_from!(ObjectType<'q>, ObjType);

pub fn get_federation_metadata<'q, T: Into<SchemaRef<'q>>>(
    handle: T,
) -> Option<FederationMetadata<'q>> {
    match handle.into() {
        SchemaRef::FieldDef(field_def) => unimplemented!(),
        SchemaRef::TypeDef(type_def) => unimplemented!(),
        SchemaRef::ObjType(object_type) => unimplemented!(),
    }
}