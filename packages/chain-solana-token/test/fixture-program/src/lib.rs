//! Local-only fixture: a tiny native program that implements the classic
//! pump.fun `buy` instruction layout and Global / BondingCurve account layouts,
//! so the adapter can be exercised end-to-end against solana-test-validator.
//!
//! Instructions (first 8 bytes):
//!   buy           [102,6,61,18,1,218,235,234] amount:u64 max_sol_cost:u64
//!   init_global   [0xF1;8] fee_bps:u64 fee_recipient:[u8;32]
//!                 accounts: authority(s,w), global(w), system
//!   create_curve  [0xF2;8] v_tok:u64 v_sol:u64 real_tok:u64 total_supply:u64
//!                 accounts: authority(s,w), global, mint, bonding_curve(w), system
//!   set_complete  [0xF3;8]
//!                 accounts: authority(s), global, bonding_curve(w)

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

const BUY: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
const INIT_GLOBAL: [u8; 8] = [0xF1; 8];
const CREATE_CURVE: [u8; 8] = [0xF2; 8];
const SET_COMPLETE: [u8; 8] = [0xF3; 8];

const GLOBAL_DISC: [u8; 8] = [167, 232, 232, 177, 200, 108, 114, 127];
const CURVE_DISC: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
const GLOBAL_LEN: usize = 113;
const CURVE_LEN: usize = 81;

// pump.fun error codes.
const NOT_AUTHORIZED: u32 = 6000;
const ALREADY_INITIALIZED: u32 = 6001;
const TOO_MUCH_SOL_REQUIRED: u32 = 6002;
const MINT_MISMATCH: u32 = 6004;
const CURVE_COMPLETE: u32 = 6005;
const NOT_INITIALIZED: u32 = 6007;

entrypoint!(process);

fn err(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

fn rd_u64(d: &[u8], o: usize) -> Result<u64, ProgramError> {
    d.get(o..o + 8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
        .ok_or(ProgramError::InvalidInstructionData)
}

fn wr_u64(d: &mut [u8], o: usize, v: u64) {
    d[o..o + 8].copy_from_slice(&v.to_le_bytes());
}

fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    program_id: &Pubkey,
    len: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    let lamports = Rent::get()?.minimum_balance(len);
    invoke_signed(
        &system_instruction::create_account(payer.key, target.key, lamports, len as u64, program_id),
        &[payer.clone(), target.clone(), system.clone()],
        &[seeds],
    )
}

fn load_global(program_id: &Pubkey, global: &AccountInfo) -> Result<(Pubkey, Pubkey, u64), ProgramError> {
    let (expected, _) = Pubkey::find_program_address(&[b"global"], program_id);
    if *global.key != expected || global.owner != program_id {
        return Err(err(NOT_INITIALIZED));
    }
    let d = global.try_borrow_data()?;
    if d.len() < GLOBAL_LEN || d[..8] != GLOBAL_DISC || d[8] != 1 {
        return Err(err(NOT_INITIALIZED));
    }
    let authority = Pubkey::try_from(&d[9..41]).unwrap();
    let fee_recipient = Pubkey::try_from(&d[41..73]).unwrap();
    Ok((authority, fee_recipient, rd_u64(&d, 105)?))
}

fn check_curve(program_id: &Pubkey, mint: &Pubkey, curve: &AccountInfo) -> Result<u8, ProgramError> {
    let (expected, bump) = Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], program_id);
    if *curve.key != expected {
        return Err(err(MINT_MISMATCH));
    }
    Ok(bump)
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (tag, args) = data.split_at(8);
    let it = &mut accounts.iter();
    match <[u8; 8]>::try_from(tag).unwrap() {
        INIT_GLOBAL => {
            let authority = next_account_info(it)?;
            let global = next_account_info(it)?;
            let system = next_account_info(it)?;
            if !authority.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let (expected, bump) = Pubkey::find_program_address(&[b"global"], program_id);
            if *global.key != expected {
                return Err(ProgramError::InvalidSeeds);
            }
            if global.owner == program_id {
                return Err(err(ALREADY_INITIALIZED));
            }
            let fee_bps = rd_u64(args, 0)?;
            let fee_recipient = args.get(8..40).ok_or(ProgramError::InvalidInstructionData)?;
            create_pda(authority, global, system, program_id, GLOBAL_LEN, &[b"global", &[bump]])?;
            let mut d = global.try_borrow_mut_data()?;
            d[..8].copy_from_slice(&GLOBAL_DISC);
            d[8] = 1;
            d[9..41].copy_from_slice(authority.key.as_ref());
            d[41..73].copy_from_slice(fee_recipient);
            wr_u64(&mut d, 105, fee_bps);
            Ok(())
        }
        CREATE_CURVE => {
            let authority = next_account_info(it)?;
            let global = next_account_info(it)?;
            let mint = next_account_info(it)?;
            let curve = next_account_info(it)?;
            let system = next_account_info(it)?;
            let (auth, _, _) = load_global(program_id, global)?;
            if !authority.is_signer || *authority.key != auth {
                return Err(err(NOT_AUTHORIZED));
            }
            let bump = check_curve(program_id, mint.key, curve)?;
            create_pda(authority, curve, system, program_id, CURVE_LEN, &[b"bonding-curve", mint.key.as_ref(), &[bump]])?;
            let mut d = curve.try_borrow_mut_data()?;
            d[..8].copy_from_slice(&CURVE_DISC);
            wr_u64(&mut d, 8, rd_u64(args, 0)?); // virtual token
            wr_u64(&mut d, 16, rd_u64(args, 8)?); // virtual sol
            wr_u64(&mut d, 24, rd_u64(args, 16)?); // real token
            wr_u64(&mut d, 32, 0); // real sol
            wr_u64(&mut d, 40, rd_u64(args, 24)?); // total supply
            d[48] = 0;
            d[49..81].copy_from_slice(authority.key.as_ref()); // creator
            Ok(())
        }
        SET_COMPLETE => {
            let authority = next_account_info(it)?;
            let global = next_account_info(it)?;
            let curve = next_account_info(it)?;
            let (auth, _, _) = load_global(program_id, global)?;
            if !authority.is_signer || *authority.key != auth || curve.owner != program_id {
                return Err(err(NOT_AUTHORIZED));
            }
            curve.try_borrow_mut_data()?[48] = 1;
            Ok(())
        }
        BUY => {
            let global = next_account_info(it)?;
            let fee_recipient = next_account_info(it)?;
            let mint = next_account_info(it)?;
            let curve = next_account_info(it)?;
            let curve_ata = next_account_info(it)?;
            let user_ata = next_account_info(it)?;
            let user = next_account_info(it)?;
            let system = next_account_info(it)?;
            let token_program = next_account_info(it)?;
            let _rent = next_account_info(it)?;
            let _event_authority = next_account_info(it)?;
            let _program = next_account_info(it)?;

            let amount = rd_u64(args, 0)?;
            let max_sol_cost = rd_u64(args, 8)?;
            if !user.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let (_, expected_fee_recipient, fee_bps) = load_global(program_id, global)?;
            if *fee_recipient.key != expected_fee_recipient {
                return Err(err(NOT_AUTHORIZED));
            }
            let bump = check_curve(program_id, mint.key, curve)?;
            if curve.owner != program_id {
                return Err(err(MINT_MISMATCH));
            }

            let (v_tok, v_sol, r_tok, r_sol) = {
                let d = curve.try_borrow_data()?;
                if d.len() < CURVE_LEN || d[..8] != CURVE_DISC {
                    return Err(ProgramError::InvalidAccountData);
                }
                if d[48] == 1 {
                    return Err(err(CURVE_COMPLETE));
                }
                (rd_u64(&d, 8)?, rd_u64(&d, 16)?, rd_u64(&d, 24)?, rd_u64(&d, 32)?)
            };
            let amount = amount.min(r_tok);
            if amount == 0 || amount >= v_tok {
                return Err(ProgramError::InvalidArgument);
            }
            let sol_cost = ((amount as u128 * v_sol as u128) / (v_tok - amount) as u128 + 1) as u64;
            let fee = ((sol_cost as u128 * fee_bps as u128) / 10_000) as u64;
            if sol_cost + fee > max_sol_cost {
                msg!("sol_cost {} + fee {} > max_sol_cost {}", sol_cost, fee, max_sol_cost);
                return Err(err(TOO_MUCH_SOL_REQUIRED));
            }

            invoke(
                &system_instruction::transfer(user.key, curve.key, sol_cost),
                &[user.clone(), curve.clone(), system.clone()],
            )?;
            if fee > 0 {
                invoke(
                    &system_instruction::transfer(user.key, fee_recipient.key, fee),
                    &[user.clone(), fee_recipient.clone(), system.clone()],
                )?;
            }
            // SPL Token Transfer (tag 3) from the curve's ATA, signed by the curve PDA.
            let mut ix_data = vec![3u8];
            ix_data.extend_from_slice(&amount.to_le_bytes());
            invoke_signed(
                &Instruction {
                    program_id: *token_program.key,
                    accounts: vec![
                        AccountMeta::new(*curve_ata.key, false),
                        AccountMeta::new(*user_ata.key, false),
                        AccountMeta::new_readonly(*curve.key, true),
                    ],
                    data: ix_data,
                },
                &[curve_ata.clone(), user_ata.clone(), curve.clone(), token_program.clone()],
                &[&[b"bonding-curve", mint.key.as_ref(), &[bump]]],
            )?;

            let mut d = curve.try_borrow_mut_data()?;
            wr_u64(&mut d, 8, v_tok - amount);
            wr_u64(&mut d, 16, v_sol + sol_cost);
            wr_u64(&mut d, 24, r_tok - amount);
            wr_u64(&mut d, 32, r_sol + sol_cost);
            if r_tok - amount == 0 {
                d[48] = 1;
            }
            msg!("buy: {} tokens for {} lamports + {} fee", amount, sol_cost, fee);
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
