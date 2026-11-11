"""The Lookup query builder splits input the way the index's default tokenizer
does, so punctuation inside a name or address never yields a term the index
can't hold."""

from __future__ import annotations

from src.quickwit import build_person_query


def test_hyphenated_house_number_searches_each_part() -> None:
    assert build_person_query(address="32-14 Broadway") == (
        "(address_line_1:32 AND address_line_1:14 AND address_line_1:Broadway*)"
    )


def test_numbers_are_exact_except_the_last_token() -> None:
    # `14` must not match `147`, and `32` must not be met by `32nd`.
    assert build_person_query(address="32-14 32nd St") == (
        "(address_line_1:32 AND address_line_1:14 AND address_line_1:32nd* AND address_line_1:St*)"
    )
    # The last token may still be mid-typing.
    assert build_person_query(address="37-1") == "(address_line_1:37 AND address_line_1:1*)"


def test_apostrophes_and_hyphens_in_names_split() -> None:
    assert build_person_query(last_name="O'Brien") == "(last_name:O* AND last_name:Brien*)"
    assert build_person_query(last_name="Smith-Jones") == "(last_name:Smith* AND last_name:Jones*)"


def test_accented_letters_stay_in_one_token() -> None:
    assert build_person_query(last_name="Muñoz") == "(last_name:Muñoz*)"


def test_punctuation_only_input_is_no_clause() -> None:
    assert build_person_query(address=" - ", city="'") == ""


def test_fields_are_anded_and_exact_fields_stay_whole() -> None:
    assert build_person_query(first_name="free", zip5="10009", external_id="NY000000000000000001") == (
        "(first_name:free*) AND zip5:10009 AND external_id:NY000000000000000001"
    )


def test_phone_matches_digits_from_the_start() -> None:
    assert build_person_query(phone="(305) 555-") == "phone:305555*"
    assert build_person_query(phone=" - ") == ""


def test_email_is_lowercased_and_escaped() -> None:
    assert build_person_query(email="Jane+Doe@") == "email:jane\\+doe@*"


def test_contact_fields_and_with_the_rest() -> None:
    assert build_person_query(last_name="garcia", phone="305") == "(last_name:garcia*) AND phone:305*"
