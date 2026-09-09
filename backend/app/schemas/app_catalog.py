from pydantic import BaseModel, Field


class AppTemplateEnvFieldRead(BaseModel):
    name: str
    label: str
    description: str | None = None
    default: str | None = None
    select: list[dict] | None = None


class AppTemplateRead(BaseModel):
    id: int  # ordinal index within the current cached fetch - see app_templates.py
    type: int
    title: str
    description: str
    categories: list[str] = Field(default_factory=list)
    logo: str | None = None
    note: str | None = None
    platform: str | None = None
    env: list[AppTemplateEnvFieldRead] = Field(default_factory=list)


class AppCatalogSettingsRead(BaseModel):
    template_url: str


class AppCatalogSettingsUpdate(BaseModel):
    template_url: str = Field(min_length=1, max_length=1000)


class RenderTemplateRequest(BaseModel):
    env: dict[str, str] = Field(default_factory=dict)


class RenderTemplateResponse(BaseModel):
    compose_yaml: str
    suggested_name: str
