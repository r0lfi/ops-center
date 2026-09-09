from pydantic import BaseModel, Field


class AnsiblePlaybookRead(BaseModel):
    name: str
    content: str


class AnsiblePlaybookUpdate(BaseModel):
    content: str = Field(min_length=1)
